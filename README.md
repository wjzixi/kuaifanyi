# 快翻译 Kuaifanyi

Obsidian 选中即翻译插件 —— 短词查词典，长句流式翻译，AI 解释并行生成，豆包神经语音朗读。

## ✨ 特点

| 特性 | 说明 |
|------|------|
| 🎯 **双模式智能切换** | 短词/缩写自动走**词典模式**（音标、多领域释义、例句，模仿有道）；长句走**流式翻译**，逐字渲染 |
| 🌐 **方向自动识别** | 中文→英文，其它语言→中文，无需设置 |
| 💡 **AI 解释并行生成** | 翻译与解释并行请求、同屏逐字渲染，互不阻塞 |
| 🔊 **豆包神经语音** | 火山引擎大模型语音，13 个实测音色（Vivi 2.0 / 灿灿 / 云舟等），**支持声音克隆**（粘贴 S_xxx ID 即用自己的声音） |
| 🪟 **智能弹窗** | 跟随选区、滚动实时追踪、可拖拽固定、宽高可调、内容自适应 |
| 🤖 **模型自动发现** | 填入 API Key 自动拉取可用模型，下拉选择翻译/解释模型 |
| ⚡ **触发可配** | 直接选中 / Ctrl+选中，延迟可调 |
| 🔌 **OpenAI 兼容** | 默认 DeepSeek，可换任意 OpenAI 格式端点；长文本自动分段 |

## 📦 安装

1. 下载 [Releases](../../releases) 中的 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<你的库>/.obsidian/plugins/kuaifanyi/`
3. 重启 Obsidian → 设置 → 第三方插件 → 启用「快翻译」

## ⚙️ 配置

### 翻译 API（必填）
- 默认 DeepSeek：填入 [DeepSeek API Key](https://platform.deepseek.com/api_keys)
- 或选「自定义」填任意 OpenAI 兼容端点（Kimi、智谱、本地 Ollama 等）

### 豆包语音（可选，推荐）
1. [火山引擎控制台](https://console.volcengine.com/speech) 开通「语音合成大模型」
2. 创建应用，获取 **AppID** + **Access Token**
3. 插件设置 → 朗读 → 填入即可
4. **声音克隆**：控制台「声音复刻」录 10 秒 → 得到 `S_xxx` 音色 ID → 音色选「自定义克隆音色」粘贴

## 🛠 开发

```bash
npm install
npm run dev    # watch 模式
npm run build  # 生产构建
```

技术栈：TypeScript + esbuild + Obsidian API（requestUrl / SSE 流式 / Web Speech / 火山 TTS HTTP API）

## ☕ 赞助

如果这个项目对你有帮助，欢迎自由赞助（**最低 ¥5**，心意不分多少）：

<table>
  <tr>
    <td align="center"><img src="assets/sponsor-wechat.png" width="220" alt="微信收款码"><br><b>微信支付</b></td>
    <td align="center"><img src="assets/sponsor-alipay.jpg" width="220" alt="支付宝收款码"><br><b>支付宝</b></td>
  </tr>
</table>

## License

MIT
