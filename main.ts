import {
  Plugin, MarkdownView, Notice, PluginSettingTab, Setting,
} from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import { DEFAULT_SETTINGS, API_PRESETS, ApiProvider } from "./settings";
import { streamTranslate, streamExplain, streamDictLookup, fetchModels, fetchBalance, usageStats, isWord } from "./translator";
import { speak, stopSpeaking, getChineseVoices, VOLCANO_VOICES, VOLCANO_MONTHLY_QUOTA, setTtsStateCallback, TtsState, clearTtsCache, setCacheBase } from "./tts";
import { fetchVolcanoBalance, fetchVolcanoUsage, fetchAliyunBalance } from "./volc-billing";

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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new KuaifanyiSettingTab(this.app, this));

    // TTS 状态回调
    setTtsStateCallback((s) => this.setTtsState(s));

    // 缓存基础路径（限在库内：.obsidian/plugins/kuaifanyi/tts-cache）
    setCacheBase((this.app.vault.adapter as any).basePath + "/" + (this.app.vault.configDir || ".obsidian") + "/plugins/kuaifanyi/tts-cache");

    if (this.settings.apiKey) this.tryFetchModels();
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
      editorCallback: (editor) => { const t = editor.getSelection(); if (t) { void speak(t, this.settings).then(() => this.updateUsage()); } },
    });
    this.addCommand({
      id: "translate-selection", name: "翻译选中文本",
      editorCallback: (editor) => { const t = editor.getSelection(); if (t) void this.doStream(t); },
    });
  }

  onunload(): void {
    stopSpeaking();
    this.hidePopup();
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
      void this.refreshBalance().then(() => this.updateUsage());
      void speak(text, this.settings).then(() => {
        this.updateUsage();
        window.setTimeout(() => this.updateUsage(), 100);
      });
    }
  }

  private async doStream(text: string): Promise<void> {
    if (!this.settings.apiKey) { new Notice("请先配置 API Key"); return; }
    const seq = ++this.streamSeq; // 新请求使旧请求失效
    const useDict = isWord(text);
    const twTrans = new TypeWriter();
    const twExpl = new TypeWriter();
    const promises: Promise<string>[] = [];

    if (this.settings.autoTranslate) {
      const fn = useDict ? streamDictLookup : streamTranslate;
      promises.push(
        fn(text, this.settings, (chunk) => {
          if (seq !== this.streamSeq) return;
          if (this.transEl) twTrans.update(this.transEl, chunk);
        }).then(async (result) => {
          if (seq !== this.streamSeq) return result;
          if (this.transEl) twTrans.finish(this.transEl, result);
          this.lastTrans = result;
          this.updateUsage();
          void this.refreshBalance().then(() => this.updateUsage());
          if (this.settings.autoRead && result) {
            await speak(result, this.settings);
            this.updateUsage();
          }
          return result;
        })
      );
    }

    if (this.settings.autoExplain) {
      promises.push(
        streamExplain(text, this.settings, (chunk) => {
          if (seq !== this.streamSeq) return;
          if (this.explEl) twExpl.update(this.explEl, chunk);
        }).then((result) => {
          if (seq !== this.streamSeq) return result;
          if (this.explEl) twExpl.finish(this.explEl, result);
          this.lastExpl = result;
          this.updateUsage();
          void this.refreshBalance().then(() => this.updateUsage());
          return result;
        })
      );
    }

    await Promise.allSettled(promises);
    this.updateUsage();
  }
  // ---- 弹窗 ----
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
      const label = d.createDiv("kfy-label");
      label.textContent = isDict ? "📖 词典" : "🌐 翻译";
      this.transEl = d.createDiv("kfy-text");
      this.transEl.textContent = "查询中...";
      this.makeDraggable(label);
    } else { this.transEl = null; }

    if (this.settings.autoExplain) {
      const d = this.popup.createDiv("kfy-section");
      const label = d.createDiv("kfy-label");
      label.textContent = "💡 解释";
      this.explEl = d.createDiv("kfy-text");
      this.explEl.textContent = "解释中...";
      if (!this.transEl) this.makeDraggable(label);
    } else { this.explEl = null; }

    const btnRow = this.popup.createDiv("kfy-btn-row");
    // TTS 状态指示灯 + 文字
    const indWrap = btnRow.createSpan("kfy-tts-indicator-wrap");
    this.ttsIndicator = indWrap.createSpan("kfy-tts-indicator");
    this.ttsIndicatorText = indWrap.createSpan("kfy-tts-indicator-text");
    this.ttsIndicatorText.textContent = "空闲";
    if (this.settings.autoTranslate) {
      const b = btnRow.createEl("button", { text: "🔊 读翻译" });
      b.onclick = () => { if (this.lastTrans) { void speak(this.lastTrans, this.settings).then(() => this.updateUsage()); } };
    }
    if (this.settings.autoExplain) {
      const b = btnRow.createEl("button", { text: "📢 读解释" });
      b.onclick = () => { if (this.lastExpl) { void speak(this.lastExpl, this.settings).then(() => this.updateUsage()); } };
    }

    this.usageEl = this.popup.createDiv("kfy-usage");
    // 先拉官方数据再渲染
    void this.refreshBalance().then(() => this.updateUsage());
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

    // 第二行：语音合成（本地统计+官网实时+余额）
    if (this.settings.ttsEngine === "volcano") {
      const local = this.settings.volcanoMonthChars;
      const api = this.volcanoOfficialChars;
      const chars = api ? `${api.toLocaleString()} 字` : `${local.toLocaleString()} 字`;
      const vParts: string[] = [
        `${chars} / ${VOLCANO_MONTHLY_QUOTA.toLocaleString()} 字`,
      ];
      if (this.volcanoBalanceText) vParts.push(this.volcanoBalanceText);
      const line2 = this.usageEl.createDiv("kfy-usage-line");
      line2.textContent = `语音合成  ${vParts.join("  ·  ")}`;
    }
  }

  private async refreshBalance(): Promise<void> {
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
        if (chars !== null && chars > 0) this.volcanoOfficialChars = chars;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    let dirty = false;
    // 迁移：旧版 API Key 未缓存 → 写入当前提供商的槽位
    if (this.settings.apiKey && !this.settings.providerKeys[this.settings.apiProvider]) {
      this.settings.providerKeys[this.settings.apiProvider] = this.settings.apiKey;
      dirty = true;
    }
    delete (this.settings as any).volcanoCluster;
    delete (this.settings as any).ttsBackend;
    delete (this.settings as any).targetLang;
    delete (this.settings as any).systemPrompt;
    // 迁移：旧版无效音色 ID 自动纠正为默认
    if (this.settings.volcanoVoice === "zh_female_qingxin") {
      this.settings.volcanoVoice = DEFAULT_SETTINGS.volcanoVoice;
      dirty ||= true;
    }
    // 不持久化：启动时重置计数并清官方缓存
    this.settings.volcanoMonth = "";
    this.settings.volcanoMonthChars = 0;
    this.settings.volcanoMonthCalls = 0;
    this.volcanoOfficialChars = null;
    // 一次性清理磁盘残留（仅当有脏字段时写一次）
    if (dirty) await this.saveSettings();
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}

// ========== 打字机渲染 ==========
class TypeWriter {
  private timer: number | null = null;
  private displayed = 0;
  private readonly speed = 20;

  update(el: HTMLElement, fullText: string): void {
    if (fullText.length <= this.displayed) return;
    this.renderNext(el, fullText);
  }

  finish(el: HTMLElement, fullText: string): void {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.displayed = fullText.length;
    el.textContent = fullText;
  }

  private renderNext(el: HTMLElement, fullText: string): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.displayed >= fullText.length) return;
    const chunk = Math.min(3, fullText.length - this.displayed);
    this.displayed += chunk;
    el.textContent = fullText.slice(0, this.displayed);
    if (this.displayed < fullText.length) {
      const backlog = fullText.length - this.displayed;
      this.timer = window.setTimeout(() => this.renderNext(el, fullText), backlog > 50 ? 2 : this.speed);
    }
  }
}
// ========== 设置面板 ==========
class KuaifanyiSettingTab extends PluginSettingTab {
  plugin: KuaifanyiPlugin;

  constructor(app: any, plugin: KuaifanyiPlugin) { super(app, plugin); this.plugin = plugin; }

  private async refreshModels(): Promise<void> {
    if (!this.plugin.settings.apiKey) return;
    await this.plugin.tryFetchModels();
    this.display();
  }

  display(): void {
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
          this.display();
        });
      });
    new Setting(containerEl).setName("API Key").setDesc("对应服务商的 API 密钥")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey)
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
        .addText((t) => t.setPlaceholder("https://api.deepseek.com/chat/completions")
          .setValue(this.plugin.settings.customApiUrl)
          .onChange(async (v) => { this.plugin.settings.customApiUrl = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("自定义模型").setDesc("模型名称")
        .addText((t) => t.setPlaceholder("deepseek-chat")
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
        .addText((t) => t.setPlaceholder("deepseek-v4-flash")
          .setValue(this.plugin.settings.explainModel)
          .onChange(async (v) => { this.plugin.settings.explainModel = v; await this.plugin.saveSettings(); }));
    }

    // ---- 翻译 ----
    new Setting(containerEl).setHeading().setName("🌐 翻译");
    new Setting(containerEl).setName("分段大小").setDesc("长文本每段最大字符数（短词自动走词典模式，方向中英自动）")
      .addSlider((s) => s.setLimits(500, 8000, 500).setValue(this.plugin.settings.chunkSize)
        .onChange(async (v) => { this.plugin.settings.chunkSize = v; await this.plugin.saveSettings(); }));

    // ---- 触发方式 ----
    new Setting(containerEl).setHeading().setName("⚡ 触发方式");
    new Setting(containerEl).setName("触发模式").setDesc("直接选中 | Ctrl+选中")
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

    new Setting(containerEl).setName("TTS 引擎").setDesc("豆包：火山引擎神经语音（接近真人） | 系统：本机离线语音")
      .addDropdown((dd) => {
        dd.addOption("volcano", "豆包语音（火山引擎）");
        dd.addOption("system", "系统语音（离线）");
        dd.setValue(this.plugin.settings.ttsEngine).onChange(async (v) => {
          this.plugin.settings.ttsEngine = v as "volcano" | "system";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.ttsEngine === "volcano") {
      new Setting(containerEl).setName("火山 AppID").setDesc("火山引擎控制台「语音合成大模型」获取")
        .addText((t) => t.setPlaceholder("xxxxxxxx")
          .setValue(this.plugin.settings.volcanoAppId)
          .onChange(async (v) => { this.plugin.settings.volcanoAppId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("火山 Access Token").setDesc("同上")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("xxxxxxxx-xxxx-xxxx")
            .setValue(this.plugin.settings.volcanoToken)
            .onChange(async (v) => { this.plugin.settings.volcanoToken = v; await this.plugin.saveSettings(); });
        });
      new Setting(containerEl).setName("音色").setDesc("预置音色直接选，克隆音色选最后一项后填入 ID")
        .addDropdown((dd) => {
          for (const v of VOLCANO_VOICES) dd.addOption(v.value, v.label);
          dd.addOption("__custom__", "自定义克隆音色 (S_xxx)");
          const cur = this.plugin.settings.volcanoVoice;
          const isPreset = VOLCANO_VOICES.some((v) => v.value === cur);
          dd.setValue(isPreset ? cur : "__custom__")
            .onChange(async (v) => {
              if (v === "__custom__") {
                this.plugin.settings.volcanoVoice = "";
              } else {
                this.plugin.settings.volcanoVoice = v;
              }
              await this.plugin.saveSettings();
              this.display();
            });
        });
      // 克隆音色 ID 输入框（仅自定义时显示）
      const curVoice = this.plugin.settings.volcanoVoice;
      const isPresetVoice = VOLCANO_VOICES.some((v) => v.value === curVoice);
      if (!isPresetVoice) {
        new Setting(containerEl).setName("克隆音色 ID").setDesc("火山控制台「声音复刻」生成的 S_xxx ID，Cluster 自动适配")
          .addText((t) => t.setPlaceholder("S_xxxxxxxxxxxx")
            .setValue(curVoice)
            .onChange(async (v) => { this.plugin.settings.volcanoVoice = v; await this.plugin.saveSettings(); }));
      }

      // 余额查询（可选）：火山 AccessKey
      new Setting(containerEl).setName("AccessKey ID（可选）").setDesc("用于查询账户余额，火山控制台「密钥管理」获取")
        .addText((t) => t.setPlaceholder("AKxxxx")
          .setValue(this.plugin.settings.volcanoAccessKeyId)
          .onChange(async (v) => { this.plugin.settings.volcanoAccessKeyId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("Secret AccessKey（可选）").setDesc("同上，仅本地存储")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("SKxxxx")
            .setValue(this.plugin.settings.volcanoSecretAccessKey)
            .onChange(async (v) => { this.plugin.settings.volcanoSecretAccessKey = v; await this.plugin.saveSettings(); });
        });

      // 阿里云 AccessKey（可选，用于千问余额查询）
      new Setting(containerEl).setName("阿里云 AccessKey ID（可选）").setDesc("用于千问余额查询，阿里云控制台「AccessKey管理」获取")
        .addText((t) => t.setPlaceholder("LTAI5t...")
          .setValue(this.plugin.settings.aliyunAccessKeyId)
          .onChange(async (v) => { this.plugin.settings.aliyunAccessKeyId = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("阿里云 AccessKey Secret（可选）").setDesc("同上，仅本地存储")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder("...")
            .setValue(this.plugin.settings.aliyunSecretAccessKey)
            .onChange(async (v) => { this.plugin.settings.aliyunSecretAccessKey = v; await this.plugin.saveSettings(); });
        });

      // 语音缓存
      new Setting(containerEl).setName("启用语音缓存").setDesc("同一段文字不重复调用合成API，直接播放本地缓存")
        .addToggle((tg) => tg.setValue(this.plugin.settings.ttsCacheEnabled)
          .onChange(async (v) => { this.plugin.settings.ttsCacheEnabled = v; await this.plugin.saveSettings(); }));

      const vaultPath = (this.plugin.app.vault.adapter as any).basePath || ".";
      const defaultCacheDir = vaultPath + "/" + (this.app.vault.configDir || ".obsidian") + "/plugins/kuaifanyi/tts-cache";
      new Setting(containerEl).setName("缓存目录").setDesc(`存放音频文件，默认 ${defaultCacheDir}`)
        .addText((t) => t.setPlaceholder(defaultCacheDir)
          .setValue(this.plugin.settings.ttsCacheDir)
          .onChange(async (v) => { this.plugin.settings.ttsCacheDir = v; await this.plugin.saveSettings(); }))
;

      new Setting(containerEl).setName("清除语音缓存").setDesc("删除所有已缓存的语音文件")
        .addButton((btn) => btn.setButtonText("立即清除").onClick(() => {
          const dir = this.plugin.settings.ttsCacheDir || defaultCacheDir;
          const count = clearTtsCache(dir);
          new Notice(`已清除 ${count} 个缓存文件`);
        }));
    } else {
      const voices = getChineseVoices();
      if (voices.length > 0) {
        new Setting(containerEl).setName("语音").setDesc("系统中文语音（留空自动选最佳）")
          .addDropdown((dd) => {
            dd.addOption("", "自动选择");
            for (const v of voices) dd.addOption(v.name, `${v.name} (${v.lang})`);
            dd.setValue(this.plugin.settings.ttsVoice)
              .onChange(async (v) => { this.plugin.settings.ttsVoice = v; await this.plugin.saveSettings(); });
          });
      }
    }

    new Setting(containerEl).setName("语速").setDesc("0.5 ~ 2.0（豆包映射 0.8~2.0）")
      .addSlider((s) => s.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.ttsRate)
        .onChange(async (v) => { this.plugin.settings.ttsRate = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("音调").setDesc("0.5 ~ 2.0")
      .addSlider((s) => s.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.ttsPitch)
        .onChange(async (v) => { this.plugin.settings.ttsPitch = v; await this.plugin.saveSettings(); }));
  }
}
