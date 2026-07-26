// ============ 有道智云翻译（免费 100 万字符/月） ============
// 文档：https://ai.youdao.com/DOCSIRMA/html/trans/api/wbfy/index.html
// 签名：SHA256(appId + text + salt + curtime + key)，POST form-encoded
import { requestUrl } from "obsidian";
import crypto from "crypto";

/** 语言代码映射：插件内部 → 有道 API */
const YOUDAO_LANG: Record<string, string> = {
  zh: "zh-CHS", en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de",
  es: "es", pt: "pt", ru: "ru",
};

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/** 调用有道翻译 API，成功返回译文，失败返回 null */
export async function youdaoTranslate(
  text: string, from: string, to: string,
  appId: string, key: string
): Promise<string | null> {
  if (!appId || !key || !text.trim()) return null;
  const salt = String(Math.floor(Math.random() * 1000000000000));
  const curtime = String(Math.floor(Date.now() / 1000));
  const sign = sha256(appId + text + salt + curtime + key);
  const body = `q=${encodeURIComponent(text)}&from=${YOUDAO_LANG[from] || from}`
    + `&to=${YOUDAO_LANG[to] || to}&appKey=${appId}&salt=${salt}&sign=${sign}&signType=v3&curtime=${curtime}`;
  try {
    const resp = await requestUrl({
      url: "https://openapi.youdao.com/api",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false,
    });
    if (resp.status !== 200) return null;
    const data = resp.json as { errorCode?: string; translation?: string[] } | undefined;
    if (!data || data.errorCode !== "0") return null;
    return data.translation?.join("\n") || null;
  } catch { return null; }
}
