import { requestUrl } from "obsidian";
import type { KuaifanyiSettings } from "./settings";
import { API_PRESETS } from "./settings";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ---- 用量统计（最近一次请求） ----
export interface UsageInfo { prompt: number; completion: number; total: number; }
export const usageStats = {
  last: { prompt: 0, completion: 0, total: 0 } as UsageInfo,
  session: { prompt: 0, completion: 0, total: 0 } as UsageInfo,
};

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
    const infos = resp.json?.balance_infos;
    if (Array.isArray(infos) && infos.length > 0) {
      const b = infos[0];
      return `${b.currency === "CNY" ? "¥" : "$"}${b.total_balance}`;
    }
    return null;
  } catch { return null; }
}

// ---- SSE 流式请求 ----
async function fetchStream(
  apiUrl: string, apiKey: string, model: string,
  systemPrompt: string, userText: string,
  onChunk: (text: string) => void
): Promise<string> {
  const resp = await fetch(apiUrl, {
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
        const parsed = JSON.parse(data);
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
      } catch {}
    }
  }
  return fullText.trim();
}

// ---- 工具函数 ----

// 翻译缓存（文本）
function translationCacheDir(settings: KuaifanyiSettings): string {
  const dir = settings.ttsCacheDir || path.join(process.env.USERPROFILE || process.env.HOME || ".", "kuaifanyi-tts-cache");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cacheKey(parts: string[]): string {
  return crypto.createHash("md5").update(parts.join("|")).digest("hex") + ".txt";
}

function loadTextCache(dir: string, key: string): string | null {
  try {
    const fp = path.join(dir, key);
    if (fs.existsSync(fp)) return fs.readFileSync(fp, "utf-8");
  } catch {}
  return null;
}

function saveTextCache(dir: string, key: string, text: string): void {
  try {
    fs.writeFileSync(path.join(dir, key), text, "utf-8");
  } catch {}
}

export function isChinese(text: string): boolean {
  const chinese = text.match(/[\u4e00-\u9fff]/g);
  return chinese ? chinese.length / text.length > 0.3 : false;
}

export function detectTargetLang(text: string): string {
  return isChinese(text) ? "English" : "中文";
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
  let models = (resp.json.data || []).map((m: any) => m.id || m.model || m.name).filter(Boolean).sort();
  const filter = PROVIDER_MODEL_FILTERS[settings.apiProvider];
  if (filter) models = models.filter((m: string) => filter.test(m));
  // 只保留最新 10 个模型
  if (models.length > 10) models = models.slice(-10);
  return models;
}

// ---- 词典式查词（模仿有道，带缓存） ----
export function streamDictLookup(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  const model = settings.translateModel || getDefaultModel(settings);
  const dir = translationCacheDir(settings);
  const key = cacheKey([settings.apiProvider, model, "dict", text]);

  const cached = loadTextCache(dir, key);
  if (cached) {
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) { i += 3; onChunk(cached.slice(0, i)); if (i < cached.length) setTimeout(typewrite, 15); }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  const srcLang = isChinese(text) ? "中文" : "英文";
  const tgtLang = isChinese(text) ? "英文" : "中文";

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
    .then((result) => { saveTextCache(dir, key, result); return result; });
}

// ---- 流式翻译（带缓存） ----
export function streamTranslate(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  const targetLang = detectTargetLang(text);
  const model = settings.translateModel || getDefaultModel(settings);
  const dir = translationCacheDir(settings);
  const key = cacheKey([settings.apiProvider, model, "translate", targetLang, text]);

  const cached = loadTextCache(dir, key);
  if (cached) {
    // 缓存命中：模拟流式输出
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) {
        i += 3;
        onChunk(cached.slice(0, i));
        if (i < cached.length) setTimeout(typewrite, 15);
      }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  return fetchStream(
    getApiUrl(settings), settings.apiKey, model,
    `你是一个专业的翻译助手。将用户输入的文本翻译为${targetLang}。只输出翻译结果。`,
    text, (chunk) => onChunk(chunk)
  ).then((result) => { saveTextCache(dir, key, result); return result; });
}

// ---- 流式解释（带缓存） ----
export function streamExplain(
  text: string, settings: KuaifanyiSettings,
  onChunk: (text: string) => void
): Promise<string> {
  const model = settings.explainModel || "deepseek-v4-flash";
  const dir = translationCacheDir(settings);
  const key = cacheKey([settings.apiProvider, model, "explain", text]);

  const cached = loadTextCache(dir, key);
  if (cached) {
    let i = 0;
    const typewrite = () => {
      if (i < cached.length) { i += 3; onChunk(cached.slice(0, i)); if (i < cached.length) setTimeout(typewrite, 15); }
    };
    typewrite();
    return Promise.resolve(cached);
  }

  return fetchStream(
    getApiUrl(settings), settings.apiKey, model,
    "你是一个简洁的知识助手。用一段话解释用户选中的内容，包含背景、核心概念和关键信息。回答简洁，不超过300字。",
    text, (chunk) => onChunk(chunk)
  ).then((result) => { saveTextCache(dir, key, result); return result; });
}

export function getApiUrl(settings: KuaifanyiSettings): string {
  return settings.apiProvider === "custom" ? settings.customApiUrl : API_PRESETS[settings.apiProvider].apiUrl;
}
function getDefaultModel(settings: KuaifanyiSettings): string {
  return settings.apiProvider === "custom" ? settings.customModel : API_PRESETS[settings.apiProvider].model;
}
