import { Notice, requestUrl } from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getCacheStore } from "./cache-store";

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

/** 火山合成字符统计（本次会话） */
export const volcanoUsage = { chars: 0, calls: 0 };

/** 本月免费额度（大模型语音合成：2万字符/月） */
export const VOLCANO_MONTHLY_QUOTA = 20000;

// ---- TTS 状态回调 ----
export type TtsState = "idle" | "uploading" | "synthesizing" | "reading";
let onStateChange: ((s: TtsState) => void) | null = null;
export function setTtsStateCallback(fn: ((s: TtsState) => void) | null): void {
  onStateChange = fn;
}
function emitState(s: TtsState): void {
  if (onStateChange) onStateChange(s);
}

/** 记录用量到设置（跨月自动清零），返回当月累计 */
export function trackMonthly(s: KuaifanyiSettings, chars: number): number {
  const nowMonth = new Date().toISOString().slice(0, 7); // "2026-07"
  if (s.volcanoMonth !== nowMonth) {
    s.volcanoMonth = nowMonth;
    s.volcanoMonthChars = 0;
  }
  s.volcanoMonthChars += chars;
  s.volcanoMonthCalls += 1;
  return s.volcanoMonthChars;
}

/**
 * 清洗文本供朗读：
 * - 剔除装饰性符号（括号、Markdown 标记等），不念出声
 * - 保留句读标点（。？！，、；：…）→ TTS 据此生成语气语调（升调/强调/停顿）
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")          // URL 不念
    .replace(/[\]\[{}()【】《》「」『』""''*`#<>（）~^|\\_!=+-]/g, " ") // 所有装饰符号
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

// ---- 语音缓存 ----
let _cacheBase = "";

/** 设置缓存基础目录（由 main.ts 在 onload 时调用，限在库目录内） */
export function setCacheBase(dir: string): void {
  _cacheBase = dir;
}

function resolveCacheDir(settings: KuaifanyiSettings): string {
  if (settings.ttsCacheDir) return settings.ttsCacheDir;
  // 默认库插件目录下，不读取用户环境变量
  return _cacheBase || path.join(".", "kuaifanyi-tts-cache");
}

function safeFS(dir: string): boolean {
  // 安全检查：缓存目录必须在库范围内
  if (_cacheBase && !dir.startsWith(_cacheBase)) return false;
  return true;
}
export { safeFS };

function ensureCacheDir(dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 生成缓存文件名: MD5(文本+音色) */
function cacheName(text: string, voice: string, dir: string): string {
  const hash = crypto.createHash("md5").update(text).update(voice).digest("hex");
  return path.join(dir, hash + ".mp3");
}

function cacheKey(text: string, voice: string): string {
  return crypto.createHash("md5").update(text).update(voice).digest("hex");
}

/** 从缓存加载音频（SQLite 索引 + 磁盘文件），成功返回 blob，失败返回 null */
function loadFromCache(text: string, voice: string, dir: string): Blob | null {
  if (!text || !voice) return null;
  const key = cacheKey(text, voice);
  try {
    const db = getCacheStore();
    const audioPath = db?.getAudio(key) ?? null;
    if (audioPath && fs.existsSync(audioPath)) {
      const buf = fs.readFileSync(audioPath);
      const ab = new ArrayBuffer(buf.length);
      const view = new Uint8Array(ab);
      view.set(buf);
      return new Blob([ab], { type: "audio/mp3" });
    }
  } catch { /* Expected */ }
  return null;
}

/** 保存音频到磁盘 + SQLite 索引 */
async function saveToCache(text: string, voice: string, blob: Blob, dir: string): Promise<void> {
  if (!text || !voice || !blob) return;
  try {
    const fp = cacheName(text, voice, dir);
    const buf = await blob.arrayBuffer();
    fs.writeFileSync(fp, Buffer.from(buf));
    // 写入 SQLite 索引
    const db = getCacheStore();
    db?.setAudio(cacheKey(text, voice), text, voice, fp, Buffer.from(buf).length);
  } catch { /* Expected */ }
}

/** 清除所有缓存文件 */
export function clearTtsCache(dir: string): number {
  if (!dir || !fs.existsSync(dir)) return 0;
  let count = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith(".mp3")) {
        fs.unlinkSync(path.join(dir, f));
        count++;
      }
    }
  } catch { /* Expected */ }
  return count;
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
  const cacheDir = settings.ttsCacheEnabled ? ensureCacheDir(resolveCacheDir(settings)) : "";
  try {
    for (const chunk of chunks) {
      if (!speaking) break;
      let blob: Blob | null = null;

      // 缓存命中：直接用，不调 API
      if (cacheDir) {
        blob = loadFromCache(chunk, settings.volcanoVoice, cacheDir);
      }

      if (!blob) {
        emitState("uploading");
        blob = await volcanoSynth(chunk, settings);
        emitState("synthesizing");
        if (cacheDir) await saveToCache(chunk, settings.volcanoVoice, blob, cacheDir);
      }
      volcanoUsage.chars += chunk.length;
      volcanoUsage.calls += 1;
      trackMonthly(settings, chunk.length);
      if (!speaking) break;
      emitState("reading");
      await playBlob(blob);
    }
  } catch (e: unknown) {
    new Notice(`豆包语音失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  emitState("idle");
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

function webSpeak(text: string, settings: KuaifanyiSettings): Promise<void> {
  return new Promise((resolve) => {
    stopSpeaking();
    const cleaned = cleanForSpeech(text);
    if (!cleaned) { resolve(); return; }
    const phrases = cleaned.split(/(?<=[。！？.!?])/g).map((p) => p.trim()).filter(Boolean);
    if (!phrases.length) { resolve(); return; }

    const voice = pickBestWebVoice(settings);
    if (!voice) { new Notice("未找到可用语音，请检查系统语言包"); resolve(); return; }
    const synth = window.speechSynthesis;
    for (let i = 0; i < phrases.length; i++) {
      const utt = new SpeechSynthesisUtterance(phrases[i]);
      utt.voice = voice;
      utt.rate = settings.ttsRate;
      utt.pitch = settings.ttsPitch;
      utt.volume = 1;
      if (i === phrases.length - 1) {
        utt.onend = () => { resolve(); speaking = false; };
      } else {
        utt.onend = () => window.setTimeout(() => playNext(synth), 120);
      }
      queue.push(utt);
    }
    speaking = true;
    window.setTimeout(() => playNext(synth), 80);
  });
}

function playNext(synth: SpeechSynthesis): void {
  if (!queue.length) { speaking = false; emitState("idle"); return; }
  synth.speak(queue.shift()!);
}

// ============ 统一入口 ============
export function speak(text: string, settings: KuaifanyiSettings): Promise<void> {
  if (settings.ttsEngine === "volcano") {
    return volcanoSpeak(text, settings);
  } else {
    return webSpeak(text, settings);
  }
}

export function stopSpeaking(): void {
  speaking = false;
  emitState("idle");
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
