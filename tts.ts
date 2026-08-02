import { Notice, requestUrl } from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getStore } from "./cache-store";
import { edgeSynth, EDGE_VOICES } from "./edge-tts";

// ============ 火山豆包语音 ============
const VOLCANO_TTS_URL = "https://openspeech.bytedance.com/api/v1/tts";

/** 预置音色（火山大模型 + 多语言） */
export const VOLCANO_VOICES: Array<{ value: string; label: string; lang: string }> = [
  // 中文
  { value: "zh_female_vv_uranus_bigtts", label: "Vivi 2.0（通用女声/多方言）", lang: "zh" },
  { value: "zh_female_cancan_uranus_bigtts", label: "知性灿灿 2.0", lang: "zh" },
  { value: "zh_female_qingxinnvsheng_uranus_bigtts", label: "清新女声 2.0", lang: "zh" },
  { value: "zh_female_tianmeixiaoyuan_uranus_bigtts", label: "甜美小源 2.0", lang: "zh" },
  { value: "zh_female_linjianvhai_uranus_bigtts", label: "邻家女孩 2.0", lang: "zh" },
  { value: "zh_female_sajiaoxuemei_uranus_bigtts", label: "撒娇学妹 2.0", lang: "zh" },
  { value: "zh_female_wenroumama_uranus_bigtts", label: "温柔妈妈 2.0", lang: "zh" },
  { value: "zh_male_taocheng_uranus_bigtts", label: "小天 2.0（男声）", lang: "zh" },
  { value: "zh_male_liufei_uranus_bigtts", label: "刘飞 2.0（男声）", lang: "zh" },
  { value: "zh_male_m191_uranus_bigtts", label: "云舟 2.0（男声）", lang: "zh" },
  // 英文
  { value: "en_female_dacey_uranus_bigtts", label: "Dacey（美式英语女声）", lang: "en" },
  { value: "en_female_stokie_uranus_bigtts", label: "Stokie（美式英语女声）", lang: "en" },
  { value: "en_male_tim_uranus_bigtts", label: "Tim（美式英语男声）", lang: "en" },
];

/** 语言列表（用于翻译源/目标选择） */
export const LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" },
];

/** 朗读槽位：翻译 / 解释（音色分开设置） */
export type SpeakSlot = "trans" | "expl";

const VOICE_FALLBACK = "zh_female_vv_uranus_bigtts"; // Vivi 2.0：实测多语言通吃（中英法均验证）

/** 语音风格 → 各语言音色映射（3 男 3 女共 6 项，全部实测账号可用；未列出的语言统一回退 Vivi 2.0）
 *  用户可见项保持简单，具体音色由插件按语言自动匹配 */
export const VOICE_STYLES: Array<{ id: string; label: string; by: Record<string, string> }> = [
  { id: "standard", label: "标准女声", by: { zh: "zh_female_vv_uranus_bigtts", en: "en_female_dacey_uranus_bigtts" } },
  { id: "intellectual", label: "知性女声", by: { zh: "zh_female_cancan_uranus_bigtts", en: "en_female_stokie_uranus_bigtts" } },
  { id: "sweet", label: "甜美女声", by: { zh: "zh_female_tianmeixiaoyuan_uranus_bigtts", en: "en_female_dacey_uranus_bigtts" } },
  { id: "male_calm", label: "沉稳男声", by: { zh: "zh_male_m191_uranus_bigtts", en: "en_male_tim_uranus_bigtts" } },
  { id: "male_energetic", label: "活力男声", by: { zh: "zh_male_taocheng_uranus_bigtts", en: "en_male_tim_uranus_bigtts" } },
  { id: "male_mellow", label: "醇厚男声", by: { zh: "zh_male_liufei_uranus_bigtts", en: "en_male_tim_uranus_bigtts" } },
];

/** 旧版风格 id 兼容（避免历史设置失配） */
const LEGACY_STYLE: Record<string, string> = {
  male: "male_calm",
  male_yunzhou: "male_calm",
  male_taocheng: "male_energetic",
  gentle: "standard",
  fresh: "standard",
};

/** 解析实际音色：槽位固定音色优先；"auto" 时按风格 + 文本/槽位语言匹配，未覆盖语言回退 Vivi */
function resolveVoice(settings: KuaifanyiSettings, slot: SpeakSlot, text: string): string {
  const pref = slot === "expl" ? settings.volcanoVoiceExpl : settings.volcanoVoiceTrans;
  if (pref && pref !== "auto") return pref;
  const slotLang = slot === "expl" ? (settings.explainLang || "zh") : (settings.targetLang || "zh");
  // 自动模式：文本含中文必用中文音色；否则跟槽位目标语言
  const lang = /[\u4e00-\u9fff]/.test(text) ? "zh" : slotLang;
  // 兜底链：旧风格 id → 新 id；风格 id 失效 → 第一个（标准女声）；语言未覆盖 → Vivi
  const styleId = LEGACY_STYLE[settings.volcanoVoiceStyle] || settings.volcanoVoiceStyle;
  const style = VOICE_STYLES.find((s) => s.id === styleId) || VOICE_STYLES[0];
  return style.by[lang] || VOICE_FALLBACK;
}

let currentAudio: HTMLAudioElement | null = null;
let queue: SpeechSynthesisUtterance[] = [];
let speaking = false;
let speakGen = 0; // 发言代数计数器，保证同一时间只有一个输出

/** 语音合成用量：仅展示火山官方 API 返回值，不做本地累加 */
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


/**
 * 清洗文本供朗读：
 * - 剔除装饰性符号（括号、Markdown 标记等），不念出声
 * - 保留句读标点（。？！，、；：…）→ TTS 据此生成语气语调（升调/强调/停顿）
 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")          // URL 不念
    .replace(/[\][{}()【】《》「」『』""''*`#<>（）~^|\\_!=+-]/g, " ")
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
let _ttsDir = "";

/** 设置语音缓存目录（由 main.ts 在 onload 时调用；改目录后重载生效） */
export function setTtsCacheDir(dir: string): void {
  _ttsDir = dir;
}

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
    const db = getStore("tts");
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
    // 写入索引库
    const db = getStore("tts");
    db?.setAudio(cacheKey(text, voice), text, voice, fp, Buffer.from(buf).length);
  } catch { /* Expected */ }
}

/** 清除语音缓存：删除全部 mp3 + 清空 tts 索引库，返回删除文件数 */
export function clearTtsCache(): number {
  let count = 0;
  try {
    if (_ttsDir && fs.existsSync(_ttsDir)) {
      const files = fs.readdirSync(_ttsDir);
      for (const f of files) {
        if (f.endsWith(".mp3")) {
          fs.unlinkSync(path.join(_ttsDir, f));
          count++;
        }
      }
    }
    // 同步清空 tts 索引库
    getStore("tts")?.clearByType();
  } catch { /* Expected */ }
  return count;
}

/** 火山 TTS 响应体 */
interface VolcanoTtsResp { code?: number; message?: string; data?: string }

/** 调用火山 TTS 合成一段文本，返回音频 blob */
async function volcanoSynth(text: string, s: KuaifanyiSettings, voice: string): Promise<Blob> {
  // cluster 自动推断：克隆音色(S_xxx)用 volcano_icl，否则 volcano_tts
  const cluster = voice.startsWith("S_") ? "volcano_icl" : "volcano_tts";
  const body = {
    app: { appid: s.volcanoAppId, token: s.volcanoToken, cluster },
    user: { uid: "obsidian-kuaifanyi" },
    audio: {
      voice_type: voice,
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

  if (resp.status === 403) throw new Error("火山 TTS 403：音色无权限或对应语音产品未开通");
  if (resp.status !== 200) throw new Error(`火山 TTS HTTP ${resp.status}`);
  const data = resp.json as VolcanoTtsResp;
  if (data.code !== 3000) throw new Error(`火山 TTS: ${data.message || "合成失败"} (code ${data.code ?? "未知"})`);
  if (!data.data) throw new Error("火山 TTS 返回无音频数据");

  // base64 → blob
  const bin = atob(data.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/mp3" });
}

/** 合成 + 自动回退：音色无权限(403)或音色不支持该语言(3011)时降级到 Vivi 2.0 并提示 */
async function synthWithFallback(text: string, s: KuaifanyiSettings, voice: string): Promise<Blob> {
  try {
    return await volcanoSynth(text, s, voice);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((msg.includes("403") || msg.includes("3011") || msg.includes("unsupported language")) && voice !== VOICE_FALLBACK) {
      new Notice("音色不适用，已自动回退到 Vivi 2.0");
      return volcanoSynth(text, s, VOICE_FALLBACK);
    }
    throw e;
  }
}

/** 检测文本主导文字系统：ja/ko/ru 为火山大模型实测不支持的语言（3011） */
function dominantScript(text: string): "zh" | "ja" | "ko" | "ru" | "other" {
  const count = (re: RegExp) => (text.match(re) || []).length;
  const zh = count(/[\u4e00-\u9fff]/g);
  const ja = count(/[\u3040-\u30ff]/g); // 平假名+片假名
  const ko = count(/[\uac00-\ud7af]/g); // 韩文音节
  const ru = count(/[\u0400-\u04ff]/g); // 西里尔
  const max = Math.max(ja, ko, ru);
  if (max > zh && max > 0) return ja === max ? "ja" : ko === max ? "ko" : "ru";
  if (zh > 0) return "zh";
  return "other";
}

/** 计算 Edge 语言桶：日/韩/俄按文字系统，其余按槽位目标语言，兜底英文 */
function edgeLangOf(text: string, slotLang: string): string {
  const script = dominantScript(text);
  if (script !== "other") return script;
  return slotLang in EDGE_VOICES ? slotLang : "en";
}

/** Edge 朗读（全语言）：整段合成（WSS 流式收包）；失败抛错由上层引擎调度兜底 */
async function edgeSpeak(text: string, settings: KuaifanyiSettings, slot: SpeakSlot): Promise<void> {
  stopSpeaking();
  const myGen = ++speakGen;
  const cleaned = cleanForSpeech(text);
  if (!cleaned) return;
  const slotLang = slot === "expl" ? (settings.explainLang || "zh") : (settings.targetLang || "zh");
  const lang = edgeLangOf(cleaned, slotLang);
  const styleId = LEGACY_STYLE[settings.volcanoVoiceStyle] || settings.volcanoVoiceStyle;
  const v = EDGE_VOICES[lang];
  const voice = styleId.startsWith("male") ? v.male : v.female;

  speaking = true;
  const cacheDir = settings.ttsCacheEnabled ? ensureCacheDir(_ttsDir) : "";
  try {
    if (myGen !== speakGen) return;
    let blob: Blob | null = null;
    // 缓存命中：直接用，不连微软（Edge 免费但省一次网络往返）
    if (cacheDir) blob = loadFromCache(cleaned, voice, cacheDir);
    if (!blob) {
      emitState("uploading");
      blob = await edgeSynth(cleaned, voice, settings.ttsRate, settings.ttsPitch,
        Math.min(120000, 20000 + cleaned.length * 60)); // 超时随文本长度放大，封顶 120s
      if (myGen !== speakGen) return;
      emitState("synthesizing");
      if (cacheDir) await saveToCache(cleaned, voice, blob, cacheDir);
    }
    if (myGen !== speakGen) return;
    emitState("reading");
    await playBlob(blob);
  } catch (e) {
    if (myGen === speakGen) { emitState("idle"); speaking = false; }
    throw e;
  }
  if (myGen === speakGen) { emitState("idle"); speaking = false; }
}

/** 火山模式朗读：分段合成，逐段播放（按槽位解析音色，403 自动回退 Vivi） */
async function volcanoSpeak(text: string, settings: KuaifanyiSettings, slot: SpeakSlot): Promise<void> {
  if (!settings.volcanoAppId || !settings.volcanoToken) {
    new Notice("请在设置中配置火山引擎 appid 和 token");
    return;
  }
  stopSpeaking(); // 先停旧播放（内部 speakGen+1），再取自己的代数，否则立即失效永不发声
  const myGen = ++speakGen;
  const cleaned = cleanForSpeech(text);
  const chunks = splitForVolcano(cleaned);
  if (!chunks.length) return;

  // 按槽位解析音色（固定音色优先，auto 按语言推荐）
  const voice = resolveVoice(settings, slot, text);

  speaking = true;
  const cacheDir = settings.ttsCacheEnabled ? ensureCacheDir(_ttsDir) : "";
  try {
    for (const chunk of chunks) {
      if (myGen !== speakGen) break; // 被新请求取代
      let blob: Blob | null = null;

      // 缓存命中：直接用，不调 API
      if (cacheDir) {
        blob = loadFromCache(chunk, voice, cacheDir);
      }

      if (!blob) {
        if (myGen !== speakGen) break;
        emitState("uploading");
        blob = await synthWithFallback(chunk, settings, voice);
        if (myGen !== speakGen) break;
        emitState("synthesizing");
        if (cacheDir) await saveToCache(chunk, voice, blob, cacheDir);
      }
      if (myGen !== speakGen) break;
      emitState("reading");
      await playBlob(blob);
    }
  } catch (e: unknown) {
    // 失败抛给统一入口调度兜底（Edge → 系统语音）
    if (myGen === speakGen) { emitState("idle"); speaking = false; }
    throw e;
  }
  if (myGen === speakGen) {
    emitState("idle");
    speaking = false;
  }
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
function pickBestWebVoice(settings: KuaifanyiSettings, text: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (settings.ttsVoice) {
    const found = voices.find((v) => v.name === settings.ttsVoice);
    if (found) return found;
  }
  const script = dominantScript(text);
  // 日/韩/俄：需系统装对应语音包，没有则返回 null 由调用方提示（不用中文语音硬读）
  if (script === "ja" || script === "ko" || script === "ru") {
    return voices.find((v) => v.lang.toLowerCase().startsWith(script)) || null;
  }
  if (script === "zh") {
    const preferred = ["Xiaoxiao", "Yunyang", "Yunxi", "Tingting", "Huihui"];
    for (const name of preferred) {
      const v = voices.find((v) => v.name.includes(name));
      if (v) return v;
    }
    return voices.find((v) => v.lang.toLowerCase().startsWith("zh")) || voices[0] || null;
  }
  // 拉丁系文本优先英文语音（避免中文语音硬读英文）
  const en = voices.find((v) => v.lang.toLowerCase().startsWith("en"));
  if (en) return en;
  return voices.find((v) => v.lang.toLowerCase().startsWith("zh")) || voices[0] || null;
}

function webSpeak(text: string, settings: KuaifanyiSettings): Promise<void> {
  return new Promise((resolve) => {
    stopSpeaking();
    const cleaned = cleanForSpeech(text);
    if (!cleaned) { resolve(); return; }
    const phrases = cleaned.split(/(?<=[。！？.!?])/g).map((p) => p.trim()).filter(Boolean);
    if (!phrases.length) { resolve(); return; }

    const voice = pickBestWebVoice(settings, cleaned);
    if (!voice) { new Notice("系统未安装该语言的语音包，请在系统设置中添加"); resolve(); return; }
    const synth = window.speechSynthesis;
    for (let i = 0; i < phrases.length; i++) {
      const utt = new SpeechSynthesisUtterance(phrases[i]);
      utt.voice = voice;
      utt.rate = settings.ttsRate;
      utt.pitch = settings.ttsPitch;
      utt.volume = 1;
      if (i === phrases.length - 1) {
        utt.onend = () => { resolve(); speaking = false; emitState("idle"); };
      } else {
        utt.onend = () => window.setTimeout(() => playNext(synth), 120);
      }
      queue.push(utt);
    }
    speaking = true;
    emitState("reading");
    window.setTimeout(() => playNext(synth), 80);
  });
}

function playNext(synth: SpeechSynthesis): void {
  if (!queue.length) { speaking = false; emitState("idle"); return; }
  synth.speak(queue.shift()!);
}

// ============ 统一入口（火山 / Edge 双引擎互相兜底） ============
export async function speak(text: string, settings: KuaifanyiSettings, slot: SpeakSlot = "trans"): Promise<void> {
  const script = dominantScript(cleanForSpeech(text));
  const edgeOnly = script === "ja" || script === "ko" || script === "ru"; // 火山不支持的语言

  if (settings.ttsEngine === "edge") {
    // Edge 优先：失败回火山（中英拉丁系）；日/韩/俄火山帮不上，回系统语音
    try { return await edgeSpeak(text, settings, slot); }
    catch {
      if (edgeOnly) {
        new Notice("多语言语音不可用，已切换系统语音");
        return webSpeak(text, settings);
      }
      new Notice("多语言语音不可用，已切换火山语音");
      try { return await volcanoSpeak(text, settings, slot); }
      catch {
        new Notice("语音服务均不可用，已切换系统语音");
        return webSpeak(text, settings);
      }
    }
  }
  // 火山优先：日/韩/俄直接走 Edge；火山失败回 Edge
  if (edgeOnly) {
    try { return await edgeSpeak(text, settings, slot); }
    catch {
      new Notice("多语言语音不可用，已切换系统语音");
      return webSpeak(text, settings);
    }
  }
  try { return await volcanoSpeak(text, settings, slot); }
  catch {
    new Notice("火山语音不可用，已切换多语言语音");
    try { return await edgeSpeak(text, settings, slot); }
    catch {
      new Notice("语音服务均不可用，已切换系统语音");
      return webSpeak(text, settings);
    }
  }
}

export function stopSpeaking(): void {
  ++speakGen;
  speaking = false;
  emitState("idle");
  window.speechSynthesis.cancel();
  queue = [];
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = ""; // 彻底释放
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
