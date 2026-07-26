import { requestUrl } from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import { API_PRESETS } from "./settings";
import crypto from "crypto";
import { getStore } from "./cache-store";
import { baiduTranslate } from "./baidu-translate";
import { youdaoTranslate } from "./youdao-translate";

// ---- 用量统计（最近一次请求） ----
export interface UsageInfo { prompt: number; completion: number; total: number; }
export const usageStats = {
  last: { prompt: 0, completion: 0, total: 0 },
  session: { prompt: 0, completion: 0, total: 0 },
};

/** 余额端点（/user/balance）响应体 */
interface BalanceResp { balance_infos?: Array<{ currency?: string; total_balance?: string }> }

/** 查询账户余额（OpenAI 兼容 /user/balance 端点），返回 "¥xx.xx" 或 null */
export async function fetchBalance(settings: KuaifanyiSettings): Promise<string | null> {
  try {
    const baseUrl = getApiUrl(settings).replace(/\/chat\/completions\/?$/, "");
    const resp = await requestUrl({
      url: baseUrl + "/user/balance", method: "GET",
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      throw: false,
    });
    if (resp.status !== 200) return null;
    const infos = (resp.json as BalanceResp | undefined)?.balance_infos;
    if (Array.isArray(infos) && infos.length > 0) {
      const b = infos[0];
      return `${b.currency === "CNY" ? "¥" : "$"}${b.total_balance}`;
    }
    return null;
  } catch { return null; }
}

// ---- SSE 流式请求 ----
interface SseChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: Array<{ delta?: { content?: string } }>;
}

async function fetchStream(
  apiUrl: string, apiKey: string, model: string,
  systemPrompt: string, userText: string,
  onChunk: (text: string) => void
): Promise<string> {
  // SSE 流式必须逐块读取响应体，requestUrl 不支持流式读取，此处只能走 window.fetch
  const resp = await window.fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, temperature: 0.3, max_tokens: 4096, stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!resp.ok || !resp.body) throw new Error(`流式请求失败 (${resp.status})`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as SseChunk;
        // 末尾的 usage 块（stream_options.include_usage）
        if (parsed.usage) {
          const u = parsed.usage;
          usageStats.last = {
            prompt: u.prompt_tokens || 0,
            completion: u.completion_tokens || 0,
            total: u.total_tokens || 0,
          };
          usageStats.session.prompt += usageStats.last.prompt;
          usageStats.session.completion += usageStats.last.completion;
          usageStats.session.total += usageStats.last.total;
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) { fullText += delta; onChunk(fullText); }
      } catch { /* Expected */ }
    }
  }
  return fullText.trim();
}

// ---- 工具函数 ----

function cacheKey(parts: string[]): string {
  return crypto.createHash("md5").update(parts.join("|")).digest("hex");
}

export function isChinese(text: string): boolean {
  const chinese = text.match(/[\u4e00-\u9fff]/g);
  return chinese ? chinese.length / text.length > 0.3 : false;
}

function langName(code: string): string {
  const found = [{ value: "zh", label: "中文" }, { value: "en", label: "English" }, { value: "ja", label: "日本語" },
    { value: "ko", label: "한국어" }, { value: "fr", label: "Français" }, { value: "de", label: "Deutsch" },
    { value: "es", label: "Español" }, { value: "pt", label: "Português" }, { value: "ru", label: "Русский" },
  ].find(l => l.value === code);
  return found?.label || code;
}
export { langName };

/** 推测源语言（文字系统判定：非拉丁脚本可精确定位，拉丁系返回 other） */
function guessSourceLang(text: string): string {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  return "other";
}

/** 单词/短语翻译（免费 API 优先 → 大模型兜底），返回译文；带缓存 */
export async function translateWord(text: string, settings: KuaifanyiSettings): Promise<string> {
  const tgt = settings.targetLang || "zh";
  const src = guessSourceLang(text);
  if (src === tgt) return text; // 同语言直显原文

  const provider = settings.dictProvider || "llm";
  const key = cacheKey([provider, "dict-word", tgt, text]);
  const db = getStore("translate");
  const cached = db?.getText(key) ?? null;
  if (cached) return cached;

  let result: string | null = null;

  if (provider === "baidu") {
    result = await baiduTranslate(text, src, tgt, settings.baiduAppId, settings.baiduKey);
  } else if (provider === "youdao") {
    result = await youdaoTranslate(text, src, tgt, settings.youdaoAppId, settings.youdaoKey);
  }

  if (result) {
    db?.setText(key, "dict", text, result, provider, "");
  } else {
    // 免费 API 不可用（无 key/网络/配额）→ 大模型兜底
    // 兜底结果不缓存：下次主 API 恢复后能拿到正确译文
    result = await streamDictLookup(text, settings, () => {});
  }
  return result;
}

export function detectTargetLang(text: string, settings: KuaifanyiSettings): string {
  return langName(settings.targetLang || "zh");
}

/** 判断是否为单词/组词（查词典模式） */
export function isWord(text: string): boolean {
  const t = text.trim();
  if (isChinese(t)) {
    // 中文词组：不长，没有句末标点
    return t.length <= 20 && !/[。！？\n]/.test(t);
  }
  // 英文单词：单个词或简短短语
  return t.length <= 50 && !/[.!?\n]/.test(t) && t.split(/\s+/).length <= 5;
}

// ---- 模型列表 ----
const PROVIDER_MODEL_FILTERS: Record<string, RegExp> = {
  deepseek: /deepseek/i,
  qwen: /qwen/i,
  doubao: /doubao|ark/i,
  kimi: /moonshot/i,
  zhipu: /glm|zhipu|cogview|charglm/i,
};

export async function fetchModels(settings: KuaifanyiSettings): Promise<string[]> {
  const apiUrl = getApiUrl(settings);
  const baseUrl = apiUrl.replace(/\/chat\/completions\/?$/, "");
  const resp = await requestUrl({
    url: baseUrl + "/models", method: "GET",
    headers: { Authorization: `Bearer ${settings.apiKey}` },
  });
  if (resp.status !== 200) throw new Error(`获取模型列表失败 (${resp.status})`);
  const raw = (resp.json as { data?: Array<{ id?: string; model?: string; name?: string }> }).data || [];
  let models = raw.map((m) => m.id || m.model || m.name || "").filter(Boolean).sort();
  const filter = PROVIDER_MODEL_FILTERS[settings.apiProvider];
  if (filter) models = models.filter((m: string) => filter.test(m));
  // 只保留最新 10 个模型
  if (models.length > 10) models = models.slice(-10);
  return models;
}

// ---- 词典式查词（SQLite 缓存） ----
export function streamDictLookup(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  const model = settings.translateModel || getDefaultModel(settings);
  const tgt = settings.targetLang;
  const targetLang = (tgt && tgt !== "auto") ? tgt : (isChinese(text) ? "en" : "zh");
  // 源语言与目标语言一致 → 不调 API，直接渲染原文
  if (guessSourceLang(text) === targetLang) {
    onChunk(text);
    return Promise.resolve(text);
  }
  const key = cacheKey([settings.apiProvider, model, "dict", targetLang, text]);

  // 查词归「翻译」类缓存库
  const db = getStore("translate");
  const cached = db?.getText(key) ?? null;
  if (cached) {
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) { i += 3; onChunk(cached.slice(0, i)); if (i < cached.length) window.setTimeout(typewrite, 15); }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  const srcLang = isChinese(text) ? "中文" : "英文";
  const tgtLang = langName(targetLang);

  const prompt = `你是一部全面的多领域词典。请详细解释"${text}"（${srcLang}），翻译为${tgtLang}：

**音标**: [音标]
**释义**:（列出所有常见释义，标注词性和使用领域）
- (词性/领域) 释义1
- (词性/领域) 释义2
- (词性/领域) 释义3
**专业释义**:（如在计算机、医学、法律、金融、工程等专业领域的含义）
- (领域) 释义
**例句**:
1. 英文例句 — 中文翻译
2. 英文例句 — 中文翻译

规则：
- 如果是大写缩写（如 API、HTTP），先列出全称，再给各领域释义
- 如果是词组/成语，给出整体释义、用法和例句
- 如果有常用搭配，也一并列出
- 音标优先用 IPA 格式
- 只输出上述格式，不要多余内容。`;

  return fetchStream(getApiUrl(settings), settings.apiKey, model, prompt, text, onChunk)
    .then((result) => { db?.setText(key, "dict", text, result, settings.apiProvider, model); return result; });
}

// ---- 流式翻译（SQLite 缓存） ----
export function streamTranslate(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  // 源语言与目标语言一致 → 不调 API，直接渲染原文
  if (guessSourceLang(text) === (settings.targetLang || "zh")) {
    onChunk(text);
    return Promise.resolve(text);
  }
  const targetLang = detectTargetLang(text, settings);
  const model = settings.translateModel || getDefaultModel(settings);
  const key = cacheKey([settings.apiProvider, model, "translate", targetLang, text]);

  const db = getStore("translate");
  const cached = db?.getText(key) ?? null;
  if (cached) {
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) {
        i += 3;
        onChunk(cached.slice(0, i));
        if (i < cached.length) window.setTimeout(typewrite, 15);
      }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  return fetchStream(
    getApiUrl(settings), settings.apiKey, model,
    `你是一个专业的翻译助手。将用户输入的文本翻译为${targetLang}。只输出翻译结果。`,
    text, (chunk) => onChunk(chunk)
  ).then((result) => { db?.setText(key, "translate", text, result, settings.apiProvider, model); return result; });
}

// ---- 流式解释（SQLite 缓存） ----
export function streamExplain(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  const model = settings.explainModel || "deepseek-v4-flash";
  const explLang = settings.explainLang || "zh";
  const key = cacheKey([settings.apiProvider, model, "explain", explLang, text]);

  const db = getStore("explain");
  const cached = db?.getText(key) ?? null;
  if (cached) {
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) { i += 3; onChunk(cached.slice(0, i)); if (i < cached.length) window.setTimeout(typewrite, 15); }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  return fetchStream(
    getApiUrl(settings), settings.apiKey, model,
    `你是一个简洁的知识助手。用一段${langName(explLang)}解释用户选中的内容，包含背景、核心概念和关键信息。回答简洁，不超过300字。`,
    text, (chunk) => onChunk(chunk)
  ).then((result) => { db?.setText(key, "explain", text, result, settings.apiProvider, model); return result; });
}

export function getApiUrl(settings: KuaifanyiSettings): string {
  return settings.apiProvider === "custom" ? settings.customApiUrl : API_PRESETS[settings.apiProvider].apiUrl;
}
function getDefaultModel(settings: KuaifanyiSettings): string {
  return settings.apiProvider === "custom" ? settings.customModel : API_PRESETS[settings.apiProvider].model;
}
