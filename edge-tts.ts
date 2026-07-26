// ============ Edge TTS（微软大声朗读通道） ============
// 免费神经语音，无需 key；用于火山大模型不支持的语言（日/韩/俄）
// 协议逐字节对齐 edge-tts 7.2.7（已实测日/韩/俄合成成功）：
// - Sec-MS-GEC 鉴权（Windows ticks 300s 对齐 + SHA256）
// - 请求头：Edge UA + chrome-extension Origin + MUID cookie（缺一则握手 403）
// - X-Timestamp 用 JS 风格日期，SSML 消息的时间戳尾部追加 Z（微软服务端怪癖）
import crypto from "crypto";
import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const WIN_EPOCH = 11644473600; // Unix → Windows file time 纪元差（秒）
const WSS_URL = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/** 各语言 Edge 神经音色（女/男，全部实测可用） */
export const EDGE_VOICES: Record<string, { female: string; male: string }> = {
  zh: { female: "zh-CN-XiaoxiaoNeural", male: "zh-CN-YunxiNeural" },
  en: { female: "en-US-AriaNeural", male: "en-US-GuyNeural" },
  ja: { female: "ja-JP-NanamiNeural", male: "ja-JP-KeitaNeural" },
  ko: { female: "ko-KR-SunHiNeural", male: "ko-KR-InJoonNeural" },
  ru: { female: "ru-RU-SvetlanaNeural", male: "ru-RU-DmitryNeural" },
  fr: { female: "fr-FR-DeniseNeural", male: "fr-FR-HenriNeural" },
  de: { female: "de-DE-KatjaNeural", male: "de-DE-ConradNeural" },
  es: { female: "es-ES-ElviraNeural", male: "es-ES-AlvaroNeural" },
  pt: { female: "pt-PT-RaquelNeural", male: "pt-PT-DuarteNeural" },
};

/** Sec-MS-GEC：SHA256((unix+WIN_EPOCH 对齐300s)×10^7 + token) 大写 hex */
function secMsGec(): string {
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7;
  return crypto.createHash("sha256").update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

/** uuid4().hex 风格小写 32 位（服务端对大小写敏感） */
function connectId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** JS Date#toString 风格 UTC 时间串（服务端严格校验格式） */
function jsDateUtc(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()}`
    + ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pct(v: number): string {
  const p = Math.round((v - 1) * 100);
  return `${p >= 0 ? "+" : ""}${p}%`;
}

function buildUrl(): string {
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&ConnectionId=${connectId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
}

function buildHeaders(): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      + " (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Cookie": `muid=${crypto.randomBytes(16).toString("hex").toUpperCase()};`,
  };
}

function configMsg(): string {
  return `X-Timestamp:${jsDateUtc()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
    + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},`
    + `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;
}

function ssmlMsg(text: string, voice: string, rate: number, pitch: number): string {
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>`
    + `<voice name='${voice}'><prosody pitch='${pct(pitch)}' rate='${pct(rate)}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
  // 注意：SSML 消息的时间戳尾部必须追加 Z（微软服务端怪癖，config 消息不要加）
  return `X-RequestId:${connectId().toUpperCase()}\r\nContent-Type:application/ssml+xml\r\n`
    + `X-Timestamp:${jsDateUtc()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** 调用 Edge TTS 合成整段文本，返回 mp3 blob；失败抛错（网络/超时/服务端错误） */
export function edgeSynth(text: string, voice: string, rate: number, pitch: number, timeoutMs = 20000): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const ws = new WebSocket(buildUrl(), { headers: buildHeaders() });
    const timer = window.setTimeout(() => {
      if (!settled) { settled = true; ws.terminate(); reject(new Error("多语言语音超时")); }
    }, timeoutMs);

    const finish = (ok: boolean, err?: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { ws.close(); } catch { /* Expected */ }
      if (ok && chunks.length > 0) resolve(new Blob(chunks as unknown as BlobPart[], { type: "audio/mp3" }));
      else reject(new Error(err || "多语言语音无音频返回"));
    };

    ws.on("open", () => {
      ws.send(configMsg());
      ws.send(ssmlMsg(text, voice, rate, pitch));
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const headerLen = data.readUInt16BE(0);
        const header = data.subarray(2, 2 + headerLen).toString("utf-8");
        if (/Path:audio\r\n/.test(header) && !/Path:audio\.metadata/.test(header)) {
          const payload = data.subarray(2 + headerLen);
          if (payload.length > 0) chunks.push(payload);
        }
      } else if (data.toString().includes("Path:turn.end")) {
        finish(true);
      }
    });
    ws.on("error", (e: Error) => finish(false, `多语言语音连接失败: ${e.message}`));
    ws.on("close", (code: number) => { if (chunks.length === 0) finish(false, `多语言语音连接关闭 (${code})`); });
  });
}
