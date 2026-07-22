import { Notice, requestUrl } from "obsidian";
import type { KuaifanyiSettings } from "./settings";

// ============ 火山豆包语音 ============
const VOLCANO_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

/** 预置音色（官方音色列表实测可用） */
export const VOLCANO_VOICES: Array<{ value: string; label: string }> = [
  { value: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0（通用女声，多方言）" },
  { value: "zh_female_cancan_uranus_bigtts", label: "知性灿灿 2.0" },
  { value: "zh_female_qingxinnvsheng_uranus_bigtts", label: "清新女声 2.0" },
  { value: "zh_female_tianmeixiaoyuan_uranus_bigtts", label: "甜美小源 2.0" },
  { value: "zh_female_linjianvhai_uranus_bigtts", label: "邻家女孩 2.0" },
  { value: "zh_female_sajiaoxuemei_uranus_bigtts", label: "撒娇学妹 2.0" },
  { value: "zh_female_wenroumama_uranus_bigtts", label: "温柔妈妈 2.0" },
  { value: "zh_male_taocheng_uranus_bigtts", label: "小天 2.0（男声）" },
  { value: "zh_male_liufei_uranus_bigtts", label: "刘飞 2.0（男声）" },
  { value: "zh_male_m191_uranus_bigtts", label: "云舟 2.0（男声）" },
  { value: "BV700_streaming", label: "灿灿 1.0（多情感）" },
  { value: "BV001_streaming", label: "通用女声 1.0" },
  { value: "BV002_streaming", label: "通用男声 1.0" },
];

let currentAudio: HTMLAudioElement | null = null;
let queue: SpeechSynthesisUtterance[] = [];
let speaking = false;

/**
 * 清洗文本供朗读：
 * - 剔除装饰性符号（括号、Markdown 标记等），不念出声
 * - 保留句读标点（。？！，、；：…）→ TTS 据此生成语气语调（升调/强调/停顿）
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")          // URL 不念
    .replace(/[【】《》「」『』""''*`#<>\[\]{}()（）~^|\\_]/g, " ") // 装饰符号
    .replace(/[—–-]{2,}/g, "，")               // 长破折号→逗号停顿
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 长文本按句切分，每段 ≤800 字（火山 HTTP 限制 1024） */
function splitForVolcano(text: string, maxLen = 800): string[] {
  const sentences = text.split(/(?<=[。！？.!?；;])/g).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) { chunks.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** 调用火山 TTS 合成一段文本，返回音频 blob */
async function volcanoSynth(text: string, s: KuaifanyiSettings): Promise<Blob> {
  // cluster 自动推断：克隆音色(S_xxx)用 volcano_icl，否则 volcano_tts
  const cluster = s.volcanoVoice.startsWith("S_") ? "volcano_icl" : "volcano_tts";
  const body = {
    app: { appid: s.volcanoAppId, token: s.volcanoToken, cluster },
    user: { uid: "obsidian-kuaifanyi" },
    audio: {
      voice_type: s.volcanoVoice,
      encoding: "mp3",
      speed_ratio: Math.min(3.0, Math.max(0.8, s.ttsRate)),
      volume_ratio: 1.0,
      pitch_ratio: Math.min(2.0, Math.max(0.5, s.ttsPitch)),
    },
    request: {
      reqid: uuid(),
      text,
      text_type: "plain",
      operation: "query",
    },
  };

  // 用 requestUrl 绕过浏览器 CORS 限制（Obsidian 官方网络栈）
  const resp = await requestUrl({
    url: VOLCANO_TTS_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer;${s.volcanoToken}`,
    },
    body: JSON.stringify(body),
    throw: false,
  });

  if (resp.status !== 200) throw new Error(`火山 TTS HTTP ${resp.status}`);
  const data = resp.json;
  if (data.code !== 3000) throw new Error(`火山 TTS: ${data.message || "合成失败"} (code ${data.code})`);
  if (!data.data) throw new Error("火山 TTS 返回无音频数据");

  // base64 → blob
  const bin = atob(data.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mp3" });
}

/** 火山模式朗读：分段合成，逐段播放 */
async function volcanoSpeak(text: string, settings: KuaifanyiSettings): Promise<void> {
  if (!settings.volcanoAppId || !settings.volcanoToken) {
    new Notice("请在设置中配置火山引擎 AppID 和 Token");
    return;
  }
  stopSpeaking();
  const cleaned = cleanForSpeech(text);
  const chunks = splitForVolcano(cleaned);
  if (!chunks.length) return;

  speaking = true;
  try {
    for (const chunk of chunks) {
      if (!speaking) break; // 被中止
      const blob = await volcanoSynth(chunk, settings);
      if (!speaking) break;
      await playBlob(blob);
    }
  } catch (e: any) {
    new Notice(`豆包语音失败: ${e.message}`);
  }
  speaking = false;
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    void audio.play();
  });
}
// ============ 系统语音（Web Speech API） ============
function pickBestWebVoice(settings: KuaifanyiSettings): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (settings.ttsVoice) {
    const found = voices.find((v) => v.name === settings.ttsVoice);
    if (found) return found;
  }
  const preferred = ["Xiaoxiao", "Yunyang", "Yunxi", "Tingting", "Huihui"];
  for (const name of preferred) {
    const v = voices.find((v) => v.name.includes(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang.startsWith("zh")) || null;
}

function webSpeak(text: string, settings: KuaifanyiSettings): void {
  stopSpeaking();
  const cleaned = cleanForSpeech(text);
  if (!cleaned) return;
  const phrases = cleaned.split(/(?<=[。！？.!?])/g).map((p) => p.trim()).filter(Boolean);
  if (!phrases.length) return;

  const voice = pickBestWebVoice(settings);
  if (!voice) {
    new Notice("未找到可用语音，请检查系统语言包");
    return;
  }
  const synth = window.speechSynthesis;
  for (let i = 0; i < phrases.length; i++) {
    const utt = new SpeechSynthesisUtterance(phrases[i]);
    utt.voice = voice;
    utt.rate = settings.ttsRate;
    utt.pitch = settings.ttsPitch;
    utt.volume = 1;
    if (i < phrases.length - 1) {
      utt.onend = () => setTimeout(() => playNext(synth), 120);
    }
    queue.push(utt);
  }
  speaking = true;
  setTimeout(() => playNext(synth), 80);
}

function playNext(synth: SpeechSynthesis): void {
  if (!queue.length) { speaking = false; return; }
  synth.speak(queue.shift()!);
}

// ============ 统一入口 ============
export function speak(text: string, settings: KuaifanyiSettings): void {
  if (settings.ttsEngine === "volcano") {
    void volcanoSpeak(text, settings);
  } else {
    webSpeak(text, settings);
  }
}

export function stopSpeaking(): void {
  speaking = false;
  window.speechSynthesis.cancel();
  queue = [];
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

export function isSpeaking(): boolean {
  return window.speechSynthesis.speaking || speaking;
}

export function getChineseVoices(): Array<{ name: string; lang: string }> {
  return window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith("zh"))
    .map((v) => ({ name: v.name, lang: v.lang }));
}
