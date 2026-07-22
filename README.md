# Kuaifanyi 快翻译

**Select text → instant dictionary / streaming translation + AI explanation + natural TTS reading. An Obsidian plugin.**

选中文本 → 词典/流式翻译 + AI 解释 + 真人感语音朗读，一站式 Obsidian 阅读助手。

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎯 **Smart dual mode** | Words/abbreviations → **dictionary card** (IPA, multi-domain definitions, examples, Youdao-style); sentences → **streaming translation** with typewriter rendering |
| 🌐 **Auto direction** | Chinese→English, others→Chinese. Zero config |
| 💡 **Parallel AI explanation** | Translation & explanation stream in parallel, rendered independently |
| 🔊 **Natural Chinese TTS** | Doubao (Volcano Engine) neural voices — 13 verified voices (Vivi 2.0, Cancan, Yunzhou...), **voice cloning supported** (record 10s, paste your `S_xxx` voice ID) |
| 🪟 **Smart popup** | Follows selection, tracks scrolling, draggable, resizable, golden-ratio default, never leaves the window |
| 🤖 **Model auto-discovery** | Paste API key → available models fetched into dropdowns |
| ⚡ **Flexible trigger** | Direct select or Ctrl+select, adjustable debounce |
| 🔌 **OpenAI-compatible** | DeepSeek by default; any OpenAI-format endpoint (Kimi, Zhipu, Ollama...) |
| 📊 **Usage meter** | Token cost (in/out split), TTS characters, and account balance in popup footer |

## 📦 Installation

1. Download `main.js`, `manifest.json`, `styles.css` from [Releases](../../releases)
2. Copy to `<vault>/.obsidian/plugins/kuaifanyi/`
3. Restart Obsidian → Settings → Community plugins → Enable **快翻译**

## ⚙️ Configuration

### Translation API (required)
- Default: DeepSeek — paste your [DeepSeek API key](https://platform.deepseek.com/api_keys)
- Or choose "Custom" for any OpenAI-compatible endpoint

### Doubao TTS (optional, recommended for Chinese)
1. Open [Volcano Engine Console](https://console.volcengine.com/speech), enable "语音合成大模型" (TTS)
2. Create an app → get **AppID** + **Access Token**
3. Plugin settings → TTS → paste them, pick a voice
4. **Voice cloning**: console "声音复刻" → record 10s → get `S_xxx` ID → select "自定义克隆音色" and paste

## 🛠 Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production
```

Stack: TypeScript + esbuild + Obsidian API (`requestUrl`, SSE streaming, Web Speech, Volcano TTS HTTP API)

---

## 中文说明

选中即翻译插件：

- **短词**（单词/缩写/词组）自动切换词典模式：音标、多领域释义、专业释义、双语例句
- **长句**流式翻译：SSE 逐字渲染，中英方向自动识别
- **AI 解释**与翻译并行生成，同屏独立渲染
- **豆包神经语音朗读**：火山引擎 2.0 音色（Vivi/灿灿/云舟等 13 款实测），支持录音克隆自己的声音
- 弹窗跟随选区、滚动追踪、可拖拽、黄金比例、高度自适应
- 模型列表自动拉取，DeepSeek 余额与 token 用量实时显示

## ☕ Sponsorship 赞助

If this plugin helps you, buy me a coffee (min ¥5) / 如果对你有帮助，欢迎自由赞助（最低 ¥5）：

<table>
  <tr>
    <td align="center"><img src="assets/sponsor-wechat.png" width="220" alt="WeChat Pay"><br><b>微信支付 WeChat</b></td>
    <td align="center"><img src="assets/sponsor-alipay.jpg" width="220" alt="Alipay"><br><b>支付宝 Alipay</b></td>
  </tr>
</table>

## License

MIT
