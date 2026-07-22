import {
  Plugin, MarkdownView, Notice, PluginSettingTab, Setting,
} from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import { DEFAULT_SETTINGS, API_PRESETS, ApiProvider } from "./settings";
import { streamTranslate, streamExplain, streamDictLookup, fetchModels, fetchBalance, usageStats, isChinese, isWord } from "./translator";
import { speak, stopSpeaking, getChineseVoices, VOLCANO_VOICES, volcanoUsage } from "./tts";

const PROVIDERS: ApiProvider[] = ["deepseek", "custom"];

export default class KuaifanyiPlugin extends Plugin {
  settings!: KuaifanyiSettings;
  cachedModels: string[] = [];
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
  private balanceText = "";

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new KuaifanyiSettingTab(this.app, this));

    if (this.settings.apiKey) this.tryFetchModels();

    const onScroll = () => {
      if (this.popup && !this.popupMoved) this.repositionPopup();
    };
    this.registerDomEvent(document, "scroll", onScroll, { capture: true });
    this.registerDomEvent(document, "wheel", onScroll, { capture: true });

    this.registerDomEvent(document, "mouseup", (evt: MouseEvent) => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.onSelection(evt), this.settings.triggerDebounce);
    });

    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      if (this.popup && !(evt.target as HTMLElement).closest(".kfy-popup")) this.hidePopup();
    });

    this.addCommand({
      id: "speak-selection", name: "朗读选中文本",
      editorCallback: (editor) => { const t = editor.getSelection(); if (t) { this.lastTrans = t; speak(t, this.settings); } },
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
      speak(text, this.settings);
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
          if (seq !== this.streamSeq) return; // 已被新请求取代
          if (this.transEl) twTrans.update(this.transEl, chunk);
        }).then((result) => {
          if (seq !== this.streamSeq) return result;
          if (this.transEl) twTrans.finish(this.transEl, result);
          this.lastTrans = result;
          if (this.settings.autoRead && result) speak(result, this.settings);
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
          return result;
        })
      );
    }

    await Promise.allSettled(promises);
    this.updateUsage();
    this.refreshBalance();
  }
  // ---- 弹窗 ----
  private showPopup(range: Range, isDict: boolean): void {
    this.popupRange = range;
    this.popupMoved = false;
    this.removePopupDom();

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
    if (this.settings.autoTranslate) {
      const b = btnRow.createEl("button", { text: "🔊 读翻译" });
      b.onclick = () => { if (this.lastTrans) speak(this.lastTrans, this.settings); };
    }
    if (this.settings.autoExplain) {
      const b = btnRow.createEl("button", { text: "📢 读解释" });
      b.onclick = () => { if (this.lastExpl) speak(this.lastExpl, this.settings); };
    }

    // 底部用量栏
    this.usageEl = this.popup.createDiv("kfy-usage");
    this.updateUsage();
  }

  private updateUsage(): void {
    if (!this.usageEl) return;
    const parts: string[] = [];
    if (usageStats.last.total > 0) {
      parts.push(`token ${usageStats.last.total}（入${usageStats.last.prompt}/出${usageStats.last.completion}）`);
    }
    if (volcanoUsage.chars > 0) {
      parts.push(`语音 ${volcanoUsage.chars}字`);
    }
    if (this.balanceText) parts.push(`余额 ${this.balanceText}`);
    this.usageEl.textContent = parts.join("  ·  ");
  }

  private refreshBalance(): void {
    if (!this.settings.apiKey) return;
    void fetchBalance(this.settings).then((b) => {
      if (b) { this.balanceText = b; this.updateUsage(); }
    });
  }

  private hidePopup(): void {
    stopSpeaking();
    this.popupRange = null;
    this.removePopupDom();
  }

  private removePopupDom(): void {
    stopSpeaking();
    if (this.popup) { this.popup.remove(); this.popup = null; }
    this.transEl = null;
    this.explEl = null;
    this.usageEl = null;
    if (this.followFrame !== null) { cancelAnimationFrame(this.followFrame); this.followFrame = null; }
  }

  private computePosition(range: Range): { top: number; left: number } {
    const ws = this.app.workspace.containerEl;
    const wsRect = ws.getBoundingClientRect();
    let rect: DOMRect;
    try { rect = range.getBoundingClientRect(); }
    catch { return { top: 100, left: 100 }; }

    // 弹窗实际高度（未渲染时按估计值）
    const popupH = this.popup?.offsetHeight || 220;
    // 内容比界面还高：限高到界面内（唯一的高度约束）
    if (this.popup) {
      this.popup.style.maxHeight =
        popupH > wsRect.height - 16 ? `${wsRect.height - 16}px` : "";
    }

    // 默认放选区下方；底边越界则上移贴齐界面底
    let top = rect.bottom - wsRect.top + 8;
    if (top + popupH > wsRect.height - 8) {
      top = Math.max(8, wsRect.height - popupH - 8);
    }
    const left = rect.left - wsRect.left;
    return {
      top: Math.max(8, top),
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
    if (this.followFrame !== null) cancelAnimationFrame(this.followFrame);
    const loop = () => {
      if (!this.popup) { this.followFrame = null; return; }
      if (!this.popupMoved) this.repositionPopup();
      this.followFrame = requestAnimationFrame(loop);
    };
    this.followFrame = requestAnimationFrame(loop);
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
    try { this.cachedModels = await fetchModels(this.settings); }
    catch { /* 静默失败 */ }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // 迁移：旧版无效音色 ID 自动纠正为默认
    if (this.settings.volcanoVoice === "zh_female_qingxin") {
      this.settings.volcanoVoice = DEFAULT_SETTINGS.volcanoVoice;
      await this.saveSettings();
    }
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
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.displayed = fullText.length;
    el.textContent = fullText;
  }

  private renderNext(el: HTMLElement, fullText: string): void {
    if (this.timer !== null) clearTimeout(this.timer);
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
    const models = this.plugin.cachedModels;
    containerEl.empty();
    containerEl.createEl("h2", { text: "快翻译 - 设置" });

    containerEl.createEl("h3", { text: "🔌 翻译 API" });
    new Setting(containerEl).setName("API 提供商").setDesc("选择翻译 API 服务商")
      .addDropdown((dd) => {
        for (const p of PROVIDERS) dd.addOption(p, API_PRESETS[p].name);
        dd.setValue(this.plugin.settings.apiProvider).onChange(async (v) => {
          this.plugin.settings.apiProvider = v as ApiProvider;
          await this.plugin.saveSettings(); this.display();
        });
      });
    new Setting(containerEl).setName("API Key").setDesc("对应服务商的 API 密钥")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v;
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
    containerEl.createEl("h3", { text: "🤖 模型选择" });
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
      new Setting(containerEl).setName("翻译模型")
        .addText((t) => t.setPlaceholder("deepseek-chat")
          .setValue(this.plugin.settings.translateModel)
          .onChange(async (v) => { this.plugin.settings.translateModel = v; await this.plugin.saveSettings(); }));
      new Setting(containerEl).setName("解释模型")
        .addText((t) => t.setPlaceholder("deepseek-v4-flash")
          .setValue(this.plugin.settings.explainModel)
          .onChange(async (v) => { this.plugin.settings.explainModel = v; await this.plugin.saveSettings(); }));
    }

    // ---- 翻译 ----
    containerEl.createEl("h3", { text: "🌐 翻译" });
    new Setting(containerEl).setName("分段大小").setDesc("长文本每段最大字符数（短词自动走词典模式，方向中英自动）")
      .addSlider((s) => s.setLimits(500, 8000, 500).setValue(this.plugin.settings.chunkSize)
        .setDynamicTooltip().onChange(async (v) => { this.plugin.settings.chunkSize = v; await this.plugin.saveSettings(); }));

    // ---- 触发方式 ----
    containerEl.createEl("h3", { text: "⚡ 触发方式" });
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
        .setDynamicTooltip().onChange(async (v) => { this.plugin.settings.triggerDebounce = v; await this.plugin.saveSettings(); }));

    // ---- 朗读 ----
    containerEl.createEl("h3", { text: "🔊 朗读" });

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
        .setDynamicTooltip().onChange(async (v) => { this.plugin.settings.ttsRate = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("音调").setDesc("0.5 ~ 2.0")
      .addSlider((s) => s.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.ttsPitch)
        .setDynamicTooltip().onChange(async (v) => { this.plugin.settings.ttsPitch = v; await this.plugin.saveSettings(); }));
  }
}
