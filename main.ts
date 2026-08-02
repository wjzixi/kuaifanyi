import {
  Plugin, MarkdownView, Notice, PluginSettingTab, Setting,
} from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import { DEFAULT_SETTINGS, API_PRESETS, ApiProvider } from "./settings";
import { streamTranslate, streamExplain, fetchModels, fetchBalance, usageStats, isWord, translateWord } from "./translator";
import { speak, stopSpeaking, VOLCANO_VOICES, VOICE_STYLES, LANG_OPTIONS, VOLCANO_MONTHLY_QUOTA, setTtsStateCallback, TtsState, clearTtsCache, setTtsCacheDir } from "./tts";
import { fetchVolcanoBalance, fetchVolcanoUsage, fetchAliyunBalance } from "./volc-billing";
import { initCacheStores, closeCacheStores, getStore, migrateLegacyIndex } from "./cache-store";
import type { CacheCategory } from "./cache-store";

const PROVIDERS: ApiProvider[] = ["deepseek", "qwen", "doubao", "kimi", "zhipu", "custom"];

export default class KuaifanyiPlugin extends Plugin {
  settings!: KuaifanyiSettings;
  cachedModels: Record<string, string[]> = {}; // 按提供商缓存模型列表
  private timer: number | null = null;
  private popup: HTMLElement | null = null;
  private transEl: HTMLElement | null = null;
  private explEl: HTMLElement | null = null;
  private lastTrans = "";
  private lastExpl = "";
  private lastSourceText = "";
  private popupRange: Range | null = null;
  private popupMoved = false;
  private followFrame: number | null = null;
  private streamSeq = 0; // 流式请求序号，用于竞态中止
  private usageEl: HTMLElement | null = null;
  private ttsIndicator: HTMLElement | null = null;
  private ttsIndicatorText: HTMLElement | null = null;
  private balanceText = "";
  private volcanoBalanceText = "";
  private volcanoOfficialChars: number | null = null;
  private refreshing = false; // refreshBalance 防并发重入

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new KuaifanyiSettingTab(this.app, this));

    // TTS 状态回调
    setTtsStateCallback((s) => this.setTtsState(s));

    // 缓存目录（configDir 由 Obsidian 保证存在，不可硬编码 .obsidian）
    // 三类分库存放：translate（翻译+查词）/ explain（解释）/ tts（语音，索引与 mp3 同目录）
    const configDir = this.app.vault.configDir;
    const basePath = (this.app.vault.adapter as unknown as { basePath: string }).basePath;
    const pluginDir = `${basePath}/${configDir}/plugins/kuaifanyi`;
    const cacheRoot = `${pluginDir}/cache`;
    const ttsDir = this.settings.ttsCacheDir || `${cacheRoot}/tts`;
    setTtsCacheDir(ttsDir);
    initCacheStores({
      translate: `${cacheRoot}/translate/index.json`,
      explain: `${cacheRoot}/explain/index.json`,
      tts: `${ttsDir}/index.json`,
    });
    // 旧版混合索引迁移（默认旧目录 + 自定义旧目录），幂等：无旧文件直接跳过
    migrateLegacyIndex(`${pluginDir}/tts-cache/cache-index.json`, ttsDir);
    if (this.settings.ttsCacheDir) migrateLegacyIndex(`${this.settings.ttsCacheDir}/cache-index.json`, ttsDir);

    if (this.settings.apiKey) void this.tryFetchModels();
    // 启动时拉一次官方数据，避免显示落盘残留
    void this.refreshBalance();

    const onScroll = () => {
      if (this.popup && !this.popupMoved) this.repositionPopup();
    };
    this.registerDomEvent(document, "scroll", onScroll, { capture: true });
    this.registerDomEvent(document, "wheel", onScroll, { capture: true });

    this.registerDomEvent(document, "mouseup", (evt: MouseEvent) => {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.onSelection(evt), this.settings.triggerDebounce);
    });

    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      if (this.popup && !(evt.target as HTMLElement).closest(".kfy-popup")) this.hidePopup();
    });

    this.addCommand({
      id: "speak-selection", name: "朗读选中文本",
      editorCallback: (editor) => { const t = editor.getSelection(); if (t) { void speak(t, this.settings).then(() => this.refreshUsageDynamic()); } },
    });
    this.addCommand({
      id: "translate-selection", name: "翻译选中文本",
      editorCallback: (editor) => { const t = editor.getSelection(); if (t) void this.doStream(t); },
    });
  }

  onunload(): void {
    stopSpeaking();
    this.hidePopup();
    closeCacheStores();
  }

  private onSelection(evt: MouseEvent): void {
    if (this.settings.triggerMode === "ctrl" && !evt.ctrlKey) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    // 仅当事件发生在 Markdown 视图内容区内才处理
    if (!view.contentEl.contains(evt.target as Node)) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (!text) return;

    const range = selection.getRangeAt(0).cloneRange();

    if ((this.settings.autoTranslate || this.settings.autoExplain) && this.settings.apiKey) {
      this.showPopup(range, isWord(text));
      void this.doStream(text);
    }

    if (this.settings.autoRead && !this.settings.autoTranslate) {
      this.refreshUsageDynamic();
      void speak(text, this.settings).then(() => this.refreshUsageDynamic());
    }
  }

  private async doStream(text: string): Promise<void> {
    if (!this.settings.apiKey) { new Notice("请先配置 API key"); return; }
    this.lastSourceText = text;
    const seq = ++this.streamSeq; // 新请求使旧请求失效
    const promises: Promise<string>[] = [];
    if (this.settings.autoTranslate) promises.push(this.runTranslate(text, seq, new TypeWriter()));
    if (this.settings.autoExplain) promises.push(this.runExplain(text, seq, new TypeWriter()));
    await Promise.allSettled(promises);
    this.updateUsage();
  }

  /** 翻译（或查词）流式执行并渲染 */
  private runTranslate(text: string, seq: number, tw: TypeWriter): Promise<string> {
    // 单词/短语走免费 API（百度/有道），长文本走大模型流式
    if (isWord(text)) return this.runDict(text, seq, tw);
    const fn = streamTranslate;
    return fn(text, this.settings, (chunk) => {
      if (seq !== this.streamSeq) return;
      if (this.transEl) tw.update(this.transEl, chunk);
    }).then(async (result) => {
      if (seq !== this.streamSeq) return result;
      if (this.transEl) tw.finish(this.transEl, result);
      this.lastTrans = result;
      this.updateUsage();
      this.refreshUsageDynamic();
      if (this.settings.autoRead && result) {
        await speak(result, this.settings, "trans");
        this.refreshUsageDynamic();
      }
      return result;
    });
  }

  /** 查词（免费 API 优先，大模型兜底）：整词返回，不流式 */
  private async runDict(text: string, seq: number, tw: TypeWriter): Promise<string> {
    const result = await translateWord(text, this.settings);
    if (seq !== this.streamSeq) return result;
    if (this.transEl) tw.finish(this.transEl, result);
    this.lastTrans = result;
    this.updateUsage();
    this.refreshUsageDynamic();
    if (this.settings.autoRead && result) {
      await speak(result, this.settings, "trans");
      this.refreshUsageDynamic();
    }
    return result;
  }

  /** 解释流式执行并渲染 */
  private runExplain(text: string, seq: number, tw: TypeWriter): Promise<string> {
    return streamExplain(text, this.settings, (chunk) => {
      if (seq !== this.streamSeq) return;
      if (this.explEl) tw.update(this.explEl, chunk);
    }).then((result) => {
      if (seq !== this.streamSeq) return result;
      if (this.explEl) tw.finish(this.explEl, result);
      this.lastExpl = result;
      this.updateUsage();
      this.refreshUsageDynamic();
      return result;
    });
  }

  // ---- 弹窗 ----
  /** 弹窗下拉选择翻译目标语言：保存后立即重译 */
  private async setTargetLang(lang: string): Promise<void> {
    this.settings.targetLang = lang;
    await this.saveSettings();
    if (this.lastSourceText && this.transEl) {
      this.transEl.textContent = "翻译中...";
      void this.runTranslate(this.lastSourceText, ++this.streamSeq, new TypeWriter());
    }
  }

  /** 弹窗下拉选择解释目标语言：保存后立即重新解释 */
  private async setExplainLang(lang: string): Promise<void> {
    this.settings.explainLang = lang;
    await this.saveSettings();
    if (this.lastSourceText && this.explEl) {
      this.explEl.textContent = "解释中...";
      void this.runExplain(this.lastSourceText, ++this.streamSeq, new TypeWriter());
    }
  }

  private showPopup(range: Range, isDict: boolean): void {
    this.popupRange = range;
    this.popupMoved = false;
    // stopSpeaking 在外层 hidePopup 调用，这里不重复
    this.removePopupDom();

    // 中止旧流（新弹窗 → 旧 doStream 的 seq 不再匹配）
    ++this.streamSeq;

    this.popup = this.app.workspace.containerEl.createDiv("kfy-popup");
    const pos = this.computePosition(range);
    this.popup.style.top = `${pos.top}px`;
    this.popup.style.left = `${pos.left}px`;

    this.startFollow();

    if (this.settings.autoTranslate) {
      const d = this.popup.createDiv("kfy-section");
      const hdr = d.createDiv("kfy-section-hdr");
      const label = hdr.createDiv("kfy-label");
      label.textContent = isDict ? "📖 词典" : "🌐 翻译";
      // 目标语言下拉（复用 Obsidian 原生 dropdown 样式，点击展开选择）
      const langSel = hdr.createEl("select", { cls: "kfy-lang-select dropdown" });
      for (const l of LANG_OPTIONS) {
        langSel.createEl("option", { text: l.label, value: l.value });
      }
      langSel.value = this.settings.targetLang;
      langSel.addEventListener("change", () => { void this.setTargetLang(langSel.value); });
      this.makeDraggable(label);
      this.transEl = d.createDiv("kfy-text");
      this.transEl.textContent = "查询中...";
    } else { this.transEl = null; }

    if (this.settings.autoExplain) {
      const d = this.popup.createDiv("kfy-section");
      const hdr = d.createDiv("kfy-section-hdr");
      const label = hdr.createDiv("kfy-label");
      label.textContent = "💡 解释";
      // 解释目标语言下拉（与翻译区同款，选择即重新解释）
      const explSel = hdr.createEl("select", { cls: "kfy-lang-select dropdown" });
      for (const l of LANG_OPTIONS) {
        explSel.createEl("option", { text: l.label, value: l.value });
      }
      explSel.value = this.settings.explainLang || "zh";
      explSel.addEventListener("change", () => { void this.setExplainLang(explSel.value); });
      if (!this.transEl) this.makeDraggable(label);
      this.explEl = d.createDiv("kfy-text");
      this.explEl.textContent = "解释中...";
    } else { this.explEl = null; }

    const btnRow = this.popup.createDiv("kfy-btn-row");
    // TTS 状态指示灯 + 文字
    const indWrap = btnRow.createSpan("kfy-tts-indicator-wrap");
    this.ttsIndicator = indWrap.createSpan("kfy-tts-indicator");
    this.ttsIndicatorText = indWrap.createSpan("kfy-tts-indicator-text");
    this.ttsIndicatorText.textContent = "空闲";
    if (this.settings.autoTranslate) {
      const b = btnRow.createEl("button", { text: "🔊 读翻译" });
      b.onclick = () => { if (this.lastTrans) { void speak(this.lastTrans, this.settings, "trans").then(() => this.refreshUsageDynamic()); } };
    }
    if (this.settings.autoExplain) {
      const b = btnRow.createEl("button", { text: "📢 读解释" });
      b.onclick = () => { if (this.lastExpl) { void speak(this.lastExpl, this.settings, "expl").then(() => this.refreshUsageDynamic()); } };
    }

    this.usageEl = this.popup.createDiv("kfy-usage");
    // 先拉官方数据再渲染
    this.refreshUsageDynamic();
  }

  private updateUsage(): void {
    if (!this.usageEl) return;
    this.usageEl.empty();

    // 第一行：用量（提供商 token + 余额）
    const providerName = API_PRESETS[this.settings.apiProvider]?.name || "API";
    const dsParts: string[] = [];
    if (usageStats.session.total > 0) {
      dsParts.push(`token ${usageStats.session.total}（入${usageStats.session.prompt}/出${usageStats.session.completion}）`);
    }
    if (this.balanceText) dsParts.push(`余额 ${this.balanceText}`);
    if (dsParts.length > 0) {
      const line1 = this.usageEl.createDiv("kfy-usage-line");
      line1.textContent = providerName + "  " + dsParts.join("  ·  ");
    }

    // 第二行：语音合成（仅显示火山官方 API 数据，本地不累计）
    if (this.settings.ttsEngine === "volcano") {
      const used = this.volcanoOfficialChars;
      const chars = used !== null ? `${used.toLocaleString()} 字` : "—";
      const vParts: string[] = [
        `${chars} / ${VOLCANO_MONTHLY_QUOTA.toLocaleString()} 字`,
      ];
      if (this.volcanoBalanceText) vParts.push(this.volcanoBalanceText);
      const line2 = this.usageEl.createDiv("kfy-usage-line");
      line2.textContent = `语音合成  ${vParts.join("  ·  ")}`;
    }
  }

  /** API 调用完成后动态同步：拉官方余额/用量 → 更新弹窗显示 */
  private refreshUsageDynamic(): void {
    void this.refreshBalance().then(() => this.updateUsage());
  }

  private async refreshBalance(): Promise<void> {
    if (this.refreshing) return; // 防并发重入（多个完成回调同时触发）
    this.refreshing = true;
    try {
      await this.doRefreshBalance();
    } finally {
      this.refreshing = false;
    }
  }

  /** 实际拉取：提供商余额 + 火山 TTS 余额/官方用量 */
  private async doRefreshBalance(): Promise<void> {
    // 按提供商查余额
    const prov = this.settings.apiProvider;
    if (this.settings.apiKey) {
      try {
        if (prov === "deepseek") {
          const b = await fetchBalance(this.settings);
          if (b) this.balanceText = b;
        } else if (prov === "doubao") {
          const { volcanoAccessKeyId, volcanoSecretAccessKey } = this.settings;
          if (volcanoAccessKeyId && volcanoSecretAccessKey) {
            const b = await fetchVolcanoBalance(volcanoAccessKeyId, volcanoSecretAccessKey);
            if (b !== null) this.balanceText = `¥${b.toFixed(2)}`;
          }
        } else if (prov === "qwen") {
          const { aliyunAccessKeyId, aliyunSecretAccessKey } = this.settings;
          if (aliyunAccessKeyId && aliyunSecretAccessKey) {
            const b = await fetchAliyunBalance(aliyunAccessKeyId, aliyunSecretAccessKey);
            if (b !== null) this.balanceText = `¥${b.toFixed(2)}`;
          }
        }
      } catch { /* Expected */ }
    }
    // 火山 TTS 余额 + 官方用量
    const { volcanoAccessKeyId, volcanoSecretAccessKey, volcanoAppId } = this.settings;
    if (volcanoAccessKeyId && volcanoSecretAccessKey) {
      try {
        const b = await fetchVolcanoBalance(volcanoAccessKeyId, volcanoSecretAccessKey);
        if (b !== null) this.volcanoBalanceText = `余额 ¥${b.toFixed(2)}`;
      } catch { /* Expected */ }
      try {
        const d = new Date();
        const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
        const end = d.toISOString().slice(0, 10);
        const chars = await fetchVolcanoUsage(volcanoAccessKeyId, volcanoSecretAccessKey, volcanoAppId, start, end);
        if (chars !== null) this.volcanoOfficialChars = chars; // 0 也是有效值（新月份清零）
      } catch { /* Expected */ }
    }
  }

  private hidePopup(): void {
    stopSpeaking();
    this.popupRange = null;
    this.removePopupDom();
  }

  private setTtsState(state: TtsState): void {
    if (!this.ttsIndicator) return;
    const colors: Record<TtsState, string> = { idle: "#888", uploading: "#f0a020", synthesizing: "#2080d0", reading: "#20b050" };
    const labels: Record<TtsState, string> = { idle: "空闲", uploading: "上传", synthesizing: "合成", reading: "朗读" };
    this.ttsIndicator.style.backgroundColor = colors[state];
    if (this.ttsIndicatorText) this.ttsIndicatorText.textContent = labels[state];
  }

  private removePopupDom(): void {
    if (this.popup) { this.popup.remove(); this.popup = null; }
    this.transEl = null;
    this.explEl = null;
    this.usageEl = null;
    this.ttsIndicator = null;
    this.ttsIndicatorText = null;
    if (this.followFrame !== null) { window.cancelAnimationFrame(this.followFrame); this.followFrame = null; }
  }

  private computePosition(range: Range): { top: number; left: number } {
    const ws = this.app.workspace.containerEl;
    const wsRect = ws.getBoundingClientRect();
    let rect: DOMRect;
    try { rect = range.getBoundingClientRect(); }
    catch { return { top: 100, left: 100 }; }

    // 选区已滚出视口（rect 为零），保持当前位置不变
    if (rect.width === 0 && rect.height === 0) {
      return this.popup ? { top: this.popup.offsetTop, left: this.popup.offsetLeft } : { top: 100, left: 100 };
    }

    // 找到内容可见区域上限（标题栏以下），避免弹窗遮挡标题
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const contentTop = view
      ? Math.max(wsRect.top, (view.contentEl.getBoundingClientRect?.().top ?? 0))
      : wsRect.top;

    const popupH = this.popup?.offsetHeight || 220;
    if (this.popup) {
      this.popup.style.maxHeight =
        popupH > wsRect.height - 16 ? `${wsRect.height - 16}px` : "";
    }

    let top = rect.bottom - wsRect.top + 8;
    if (top + popupH > wsRect.height - 8) {
      top = Math.max(contentTop - wsRect.top, wsRect.height - popupH - 8);
    }
    top = Math.max(contentTop - wsRect.top + 4, top);

    const left = rect.left - wsRect.left;
    return {
      top,
      left: Math.max(8, Math.min(left, wsRect.width - 480)),
    };
  }

  private repositionPopup(): void {
    if (!this.popup || !this.popupRange) return;
    const pos = this.computePosition(this.popupRange);
    this.popup.style.top = `${pos.top}px`;
    this.popup.style.left = `${pos.left}px`;
  }

  private startFollow(): void {
    if (this.followFrame !== null) window.cancelAnimationFrame(this.followFrame);
    const loop = () => {
      if (!this.popup) { this.followFrame = null; return; }
      if (!this.popupMoved) this.repositionPopup();
      this.followFrame = window.requestAnimationFrame(loop);
    };
    this.followFrame = window.requestAnimationFrame(loop);
  }

  private makeDraggable(handle: HTMLElement): void {
    handle.addClass("kfy-drag-handle");
    const onDown = (e: MouseEvent) => {
      if (!this.popup) return;
      this.popupMoved = true;
      const startX = e.clientX, startY = e.clientY;
      const startLeft = this.popup.offsetLeft, startTop = this.popup.offsetTop;
      const onMove = (ev: MouseEvent) => {
        if (!this.popup) return;
        this.popup.style.left = `${startLeft + ev.clientX - startX}px`;
        this.popup.style.top = `${startTop + ev.clientY - startY}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
      };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      e.preventDefault();
      e.stopPropagation();
    };
    this.registerDomEvent(handle, "mousedown", onDown);
  }

  async tryFetchModels(): Promise<void> {
    try {
      const models = await fetchModels(this.settings);
      this.cachedModels[this.settings.apiProvider] = models;
      // 智能推荐默认模型：已选的保留，默认的更新为最新
      if (models.length > 0) {
        const latest = models[models.length - 1];
        if (!this.settings.translateModel || this.settings.translateModel === "deepseek-chat") {
          this.settings.translateModel = latest;
        }
        if (!this.settings.explainModel || this.settings.explainModel === "deepseek-v4-flash") {
          this.settings.explainModel = models.length > 1 ? models[models.length - 2] : latest;
        }
      }
    }
    catch { /* 静默失败 */ }
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<KuaifanyiSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    let dirty = false;
    // 迁移：旧版 API Key 未缓存 → 写入当前提供商的槽位
    if (this.settings.apiKey && !this.settings.providerKeys[this.settings.apiProvider]) {
      this.settings.providerKeys[this.settings.apiProvider] = this.settings.apiKey;
      dirty = true;
    }
    delete (this.settings as unknown as Record<string, unknown>).volcanoCluster;
    delete (this.settings as unknown as Record<string, unknown>).ttsBackend;
    delete (this.settings as unknown as Record<string, unknown>).sourceLang;
    delete (this.settings as unknown as Record<string, unknown>).systemPrompt;
    delete (this.settings as unknown as Record<string, unknown>).volcanoVoice;
    delete (this.settings as unknown as Record<string, unknown>).edgeTtsEnabled;
    const legacyData: Record<string, unknown> | null = stored;
    // 迁移：TTS 引擎双选（火山/Edge），旧 system 归并火山
    if (legacyData?.ttsEngine === "system") {
      this.settings.ttsEngine = "volcano";
      dirty = true;
    }
    // 迁移：音色拆分为翻译/解释双槽位；老版 BV 系 1.0 音色（账号无权限会 403）→ 自动推荐
    const legacyVoice = legacyData?.volcanoVoice;
    if (typeof legacyVoice === "string" && legacyVoice) {
      if (legacyVoice.startsWith("S_")) {
        this.settings.volcanoCloneVoice = legacyVoice;
        this.settings.volcanoVoiceTrans = legacyVoice;
        this.settings.volcanoVoiceExpl = legacyVoice;
      } else if (!legacyVoice.startsWith("BV")) {
        this.settings.volcanoVoiceTrans = legacyVoice;
        this.settings.volcanoVoiceExpl = legacyVoice;
      } // BV* → 保持 auto（按目标语言推荐大模型音色）
      dirty = true;
    }
    // 迁移：翻译/解释目标语言拆分（合并期存档无 explainLang → 翻译默认英文、解释默认中文）
    if (stored && !("explainLang" in stored) && (this.settings.targetLang === "zh" || this.settings.targetLang === "auto")) {
      this.settings.targetLang = "en";
      this.settings.explainLang = "zh";
      dirty = true;
    }
    // 不持久化：启动时重置官方缓存
    this.volcanoOfficialChars = null;
    // 一次性清理磁盘残留（仅当有脏字段时写一次）
    if (dirty) await this.saveSettings();
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

// ========== 打字机渲染（流式时即时显示，LLM 逐块效果已自带；缓存回放保留动画） ==========
class TypeWriter {
  update(el: HTMLElement, fullText: string): void {
    el.textContent = fullText;
    el.scrollTop = el.scrollHeight; // 自动滚到底部
  }

  finish(el: HTMLElement, fullText: string): void {
    el.textContent = fullText;
    el.scrollTop = el.scrollHeight;
  }
}
// ========== 设置面板 ==========
class KuaifanyiSettingTab extends PluginSettingTab {
  plugin: KuaifanyiPlugin;

  constructor(app: import("obsidian").App, plugin: KuaifanyiPlugin) { super(app, plugin); this.plugin = plugin; }

  getSettingDefinitions(): ReturnType<PluginSettingTab["getSettingDefinitions"]> {
    // Declarative API not adopted yet — display() handles dynamic UI
    return [];
  }

  private async refreshModels(): Promise<void> {
    if (!this.plugin.settings.apiKey) return;
    await this.plugin.tryFetchModels();
    this.render();
  }

  /** Obsidian 生命周期入口：打开设置页时由宿主调用 */
  display(): void {
    this.render();
  }

  /** 动态渲染设置面板（条件字段多，保留命令式 UI；内部重渲染一律走此方法） */
  private render(): void {
    const { containerEl } = this;
    const models = this.plugin.cachedModels[this.plugin.settings.apiProvider] || [];
    containerEl.empty();
    new Setting(containerEl).setHeading().setName("快翻译 - 设置");

    new Setting(containerEl).setHeading().setName("🔌 翻译 API");
    new Setting(containerEl).setName("API 提供商").setDesc("选择翻译 API 服务商")
      .addDropdown((dd) => {
        for (const p of PROVIDERS) dd.addOption(p, API_PRESETS[p].name);
        dd.setValue(this.plugin.settings.apiProvider).onChange(async (v) => {
          const prev = this.plugin.settings.apiProvider;
          // 保存当前 Key 到缓存
          if (this.plugin.settings.apiKey) {
            this.plugin.settings.providerKeys[prev] = this.plugin.settings.apiKey;
          }
          this.plugin.settings.apiProvider = v as ApiProvider;
          // 自动填充新提供商的已缓存 Key
          const cached = this.plugin.settings.providerKeys[v];
          this.plugin.settings.apiKey = cached || "";
          // 重置模型为默认（无 Key 不清空旧值，避免下次切回来丢失）
          if (!cached) {
            this.plugin.settings.translateModel = "";
            this.plugin.settings.explainModel = "";
          }
          await this.plugin.saveSettings();
          // 刷新模型列表（等 API 返回再刷新面板）
          if (this.plugin.settings.apiKey) {
            await this.plugin.tryFetchModels();
          }
          this.render();
        });
      });
    new Setting(containerEl).setName("API key").setDesc("对应服务商的 API 密钥")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("Sk-...").setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v;
            // 同步写入 providerKeys
            if (v) this.plugin.settings.providerKeys[this.plugin.settings.apiProvider] = v;
            await this.plugin.saveSettings();
            void this.refreshModels();
          });
      });

    if (this.plugin.settings.apiProvider === "custom") {
      new Setting(containerEl).setName("自定义 API 地址").setDesc("OpenAI 兼容格式端点")
        .addText((t) => t.setPlaceholder("HTTPS://api.deepseek.com/chat/completions")
          .setValue(this.plugin.settings.customApiUrl)
          .onChange(async (v) => { this.plugin.settings.customApiUrl = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("自定义模型").setDesc("模型名称")
        .addText((t) => t.setPlaceholder("Deepseek-chat")
          .setValue(this.plugin.settings.customModel)
          .onChange(async (v) => { this.plugin.settings.customModel = v; await this.plugin.saveSettings(); }));
    }

    // 模型选择
    new Setting(containerEl).setHeading().setName("🤖 模型选择");
    if (models.length > 0) {
      new Setting(containerEl).setName("翻译模型").setDesc("用于翻译/查词的模型")
        .addDropdown((dd) => {
          for (const m of models) dd.addOption(m, m);
          dd.setValue(this.plugin.settings.translateModel || models[0])
            .onChange(async (v) => { this.plugin.settings.translateModel = v; await this.plugin.saveSettings(); });
        });
      new Setting(containerEl).setName("解释模型").setDesc("用于解释的模型（建议轻量）")
        .addDropdown((dd) => {
          for (const m of models) dd.addOption(m, m);
          dd.setValue(this.plugin.settings.explainModel || models[0])
            .onChange(async (v) => { this.plugin.settings.explainModel = v; await this.plugin.saveSettings(); });
        });
    } else {
      const defModel = API_PRESETS[this.plugin.settings.apiProvider]?.model || "";
      new Setting(containerEl).setName("翻译模型")
        .addText((t) => t.setPlaceholder(defModel || "填入 Key 后自动获取")
          .setValue(this.plugin.settings.translateModel)
          .onChange(async (v) => { this.plugin.settings.translateModel = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("解释模型")
        .addText((t) => t.setPlaceholder("Deepseek-v4-flash")
          .setValue(this.plugin.settings.explainModel)
          .onChange(async (v) => { this.plugin.settings.explainModel = v; await this.plugin.saveSettings(); }));
    }

    // ---- 翻译 ----
    new Setting(containerEl).setHeading().setName("🌐 翻译");
    new Setting(containerEl).setName("翻译目标语言").setDesc("选中文字的翻译输出语言")
      .addDropdown((dd) => {
        for (const l of LANG_OPTIONS) dd.addOption(l.value, l.label);
        dd.setValue(this.plugin.settings.targetLang).onChange(async (v) => {
          this.plugin.settings.targetLang = v; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("解释目标语言").setDesc("解释功能的输出语言")
      .addDropdown((dd) => {
        for (const l of LANG_OPTIONS) dd.addOption(l.value, l.label);
        dd.setValue(this.plugin.settings.explainLang).onChange(async (v) => {
          this.plugin.settings.explainLang = v; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("分段大小").setDesc("长文本每段最大字符数（短词自动走词典模式）")
      .addSlider((s) => s.setLimits(500, 8000, 500).setValue(this.plugin.settings.chunkSize)
        .onChange(async (v) => { this.plugin.settings.chunkSize = v; await this.plugin.saveSettings(); }));

    // ---- 单词/短语翻译提供商（免费 API 优先，缺 key 回退大模型） ----
    new Setting(containerEl).setHeading().setName("📖 单词/短语翻译");
    new Setting(containerEl).setName("翻译提供商").setDesc("选择单词/短语的翻译 API，无 key 时自动回退大模型")
      .addDropdown((dd) => {
        dd.addOption("llm", "大模型（默认）");
        dd.addOption("baidu", "百度翻译（200 万字/月）");
        dd.addOption("youdao", "有道翻译（100 万字/月）");
        dd.setValue(this.plugin.settings.dictProvider).onChange(async (v) => {
          this.plugin.settings.dictProvider = v as "llm" | "baidu" | "youdao";
          await this.plugin.saveSettings();
          this.render(); // 即时切换 AppID/密钥输入框
        });
      });
    if (this.plugin.settings.dictProvider === "baidu") {
      new Setting(containerEl).setName("百度 appid").setDesc("百度翻译开放平台创建应用获取")
        .addText((t) => t.setPlaceholder("2026...").setValue(this.plugin.settings.baiduAppId)
          .onChange(async (v) => { this.plugin.settings.baiduAppId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("百度密钥").setDesc("同上，密钥")
        .addText((tx) => { tx.inputEl.type = "password"; tx.setPlaceholder("...").setValue(this.plugin.settings.baiduKey)
        .onChange(async (v) => { this.plugin.settings.baiduKey = v; await this.plugin.saveSettings(); }); });
    }
    if (this.plugin.settings.dictProvider === "youdao") {
      new Setting(containerEl).setName("有道 appid").setDesc("有道智云控制台创建应用获取")
        .addText((t) => t.setPlaceholder("...").setValue(this.plugin.settings.youdaoAppId)
          .onChange(async (v) => { this.plugin.settings.youdaoAppId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("有道密钥").setDesc("同上")
        .addText((tx) => { tx.inputEl.type = "password"; tx.setPlaceholder("...").setValue(this.plugin.settings.youdaoKey)
        .onChange(async (v) => { this.plugin.settings.youdaoKey = v; await this.plugin.saveSettings(); }); });
    }

    // ---- 触发方式 ----
    new Setting(containerEl).setHeading().setName("⚡ 触发方式");
    new Setting(containerEl).setName("触发模式").setDesc("直接选中 | ctrl+选中")
      .addDropdown((dd) => {
        dd.addOption("direct", "直接选中"); dd.addOption("ctrl", "Ctrl+选中");
        dd.setValue(this.plugin.settings.triggerMode).onChange(async (v) => {
          this.plugin.settings.triggerMode = v as "direct" | "ctrl"; await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl).setName("选中自动翻译").setDesc("选中后自动翻译/查词")
      .addToggle((tg) => tg.setValue(this.plugin.settings.autoTranslate)
        .onChange(async (v) => { this.plugin.settings.autoTranslate = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("选中自动解释").setDesc("选中后自动解释")
      .addToggle((tg) => tg.setValue(this.plugin.settings.autoExplain)
        .onChange(async (v) => { this.plugin.settings.autoExplain = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("选中自动朗读").setDesc("翻译完成后立即朗读（中英文都读）")
      .addToggle((tg) => tg.setValue(this.plugin.settings.autoRead)
        .onChange(async (v) => { this.plugin.settings.autoRead = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("触发延迟(ms)").setDesc("选中后等待多久触发")
      .addSlider((s) => s.setLimits(100, 2000, 100).setValue(this.plugin.settings.triggerDebounce)
        .onChange(async (v) => { this.plugin.settings.triggerDebounce = v; await this.plugin.saveSettings(); }));

    // ---- 朗读 ----
    new Setting(containerEl).setHeading().setName("🔊 朗读");

    new Setting(containerEl).setName("Tts 引擎").setDesc("两引擎互相兜底：一方失败自动切换另一方，日/韩/俄走多语言语音")
      .addDropdown((dd) => {
        dd.addOption("volcano", "豆包语音（火山引擎）");
        dd.addOption("edge", "Edge 语音（免费多语言）");
        dd.setValue(this.plugin.settings.ttsEngine).onChange(async (v) => {
          this.plugin.settings.ttsEngine = v as "volcano" | "edge";
          await this.plugin.saveSettings();
          this.render();
        });
      });

    // 语音风格（两个引擎通用：火山映射音色，Edge 决定性别）
    new Setting(containerEl).setName("语音风格").setDesc("音色为自动模式时，切换语言自动匹配该风格对应音色")
      .addDropdown((dd) => {
        for (const s of VOICE_STYLES) dd.addOption(s.id, s.label);
        dd.setValue(this.plugin.settings.volcanoVoiceStyle).onChange(async (v) => {
          this.plugin.settings.volcanoVoiceStyle = v; await this.plugin.saveSettings();
        });
      });

    if (this.plugin.settings.ttsEngine === "volcano") {
      new Setting(containerEl).setName("火山 appid").setDesc("火山引擎控制台「语音合成大模型」获取")
        .addText((t) => t.setPlaceholder("Xxxxxxxx")
          .setValue(this.plugin.settings.volcanoAppId)
          .onChange(async (v) => { this.plugin.settings.volcanoAppId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("火山 access token").setDesc("同上")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("Xxxxxxxx-xxxx-xxxx")
            .setValue(this.plugin.settings.volcanoToken)
            .onChange(async (v) => { this.plugin.settings.volcanoToken = v; await this.plugin.saveSettings(); });
        });
      // 翻译/解释音色（分开设置；自动 = 按目标语言推荐大模型音色）
      const cloneId = this.plugin.settings.volcanoCloneVoice;
      const addVoiceDropdown = (name: string, get: () => string, set: (v: string) => void) => {
        new Setting(containerEl).setName(name).setDesc("自动：按目标语言推荐大模型音色")
          .addDropdown((dd) => {
            dd.addOption("auto", "自动（推荐）");
            for (const v of VOLCANO_VOICES) dd.addOption(v.value, v.label);
            if (cloneId) dd.addOption(cloneId, `克隆音色（${cloneId.slice(0, 12)}…）`);
            dd.setValue(get() || "auto").onChange(async (v) => {
              set(v);
              await this.plugin.saveSettings();
            });
          });
      };
      addVoiceDropdown("翻译音色", () => this.plugin.settings.volcanoVoiceTrans, (v) => { this.plugin.settings.volcanoVoiceTrans = v; });
      addVoiceDropdown("解释音色", () => this.plugin.settings.volcanoVoiceExpl, (v) => { this.plugin.settings.volcanoVoiceExpl = v; });
      // 克隆音色 ID（填入后上方两个音色下拉可选）
      new Setting(containerEl).setName("克隆音色 ID（可选）").setDesc("火山控制台「声音复刻」生成的 s_xxx ID，cluster 自动适配")
        .addText((t) => t.setPlaceholder("S_xxxxxxxxxxxx")
          .setValue(this.plugin.settings.volcanoCloneVoice)
          .onChange(async (v) => { this.plugin.settings.volcanoCloneVoice = v.trim(); await this.plugin.saveSettings(); this.render(); }));

      // 余额查询（可选）：火山 AccessKey
      new Setting(containerEl).setName("Accesskey ID（可选）").setDesc("用于查询账户余额，火山控制台「密钥管理」获取")
        .addText((t) => t.setPlaceholder("Akxxxx")
          .setValue(this.plugin.settings.volcanoAccessKeyId)
          .onChange(async (v) => { this.plugin.settings.volcanoAccessKeyId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("Secret accesskey（可选）").setDesc("同上，仅本地存储")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("Skxxxx")
            .setValue(this.plugin.settings.volcanoSecretAccessKey)
            .onChange(async (v) => { this.plugin.settings.volcanoSecretAccessKey = v; await this.plugin.saveSettings(); });
        });

      // 阿里云 AccessKey（可选，用于千问余额查询）
      new Setting(containerEl).setName("阿里云 accesskey ID（可选）").setDesc("用于千问余额查询，阿里云控制台「accesskey管理」获取")
        .addText((t) => t.setPlaceholder("Ltai5t...")
          .setValue(this.plugin.settings.aliyunAccessKeyId)
          .onChange(async (v) => { this.plugin.settings.aliyunAccessKeyId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("阿里云 accesskey secret（可选）").setDesc("同上，仅本地存储")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("...")
            .setValue(this.plugin.settings.aliyunSecretAccessKey)
            .onChange(async (v) => { this.plugin.settings.aliyunSecretAccessKey = v; await this.plugin.saveSettings(); });
        });

    }

    new Setting(containerEl).setName("语速").setDesc("0.5 ~ 2.0（豆包映射 0.8~2.0）")
      .addSlider((s) => s.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.ttsRate)
        .onChange(async (v) => { this.plugin.settings.ttsRate = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("音调").setDesc("0.5 ~ 2.0")
      .addSlider((s) => s.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.ttsPitch)
        .onChange(async (v) => { this.plugin.settings.ttsPitch = v; await this.plugin.saveSettings(); }));

    // ---- 缓存管理（翻译/解释/语音 三类分库存放） ----
    new Setting(containerEl).setHeading().setName("🗃 缓存管理");
    new Setting(containerEl).setName("启用语音缓存").setDesc("同一段文字不重复调用合成API，直接播放本地缓存")
      .addToggle((tg) => tg.setValue(this.plugin.settings.ttsCacheEnabled)
        .onChange(async (v) => { this.plugin.settings.ttsCacheEnabled = v; await this.plugin.saveSettings(); }));
    const vaultPath = (this.plugin.app.vault.adapter as unknown as { basePath: string }).basePath || ".";
    const cfgDir = this.plugin.app.vault.configDir;
    const defaultTtsDir = `${vaultPath}/${cfgDir}/plugins/kuaifanyi/cache/tts`;
    new Setting(containerEl).setName("缓存目录").setDesc(`存放音频文件，默认 ${defaultTtsDir}`)
      .addText((t) => t.setPlaceholder(defaultTtsDir)
        .setValue(this.plugin.settings.ttsCacheDir)
        .onChange(async (v) => { this.plugin.settings.ttsCacheDir = v; await this.plugin.saveSettings(); }));

    // 三类缓存：条数统计 + 单独清除
    const cacheCats: Array<{ name: string; cat: CacheCategory }> = [
      { name: "翻译缓存", cat: "translate" },
      { name: "解释缓存", cat: "explain" },
      { name: "语音缓存", cat: "tts" },
    ];
    for (const c of cacheCats) {
      const st = getStore(c.cat)?.stats() ?? { count: 0, bytes: 0 };
      const sizeText = c.cat === "tts" ? `，约 ${(st.bytes / 1024 / 1024).toFixed(1)} MB` : "";
      new Setting(containerEl).setName(c.name).setDesc(`共 ${st.count} 条${sizeText}`)
        .addButton((btn) => btn.setButtonText("清除").onClick(() => {
          if (c.cat === "tts") clearTtsCache();
          else getStore(c.cat)?.clearByType();
          new Notice(`已清空${c.name}`);
          this.render();
        }));
    }
  }
}
