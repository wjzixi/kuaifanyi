// ============ 百度翻译（免费 200 万字符/月） ============
// 文档：https://fanyi-api.baidu.com/doc/21
// 签名：MD5(appid + text + salt + key)，POST form-encoded
import { requestUrl } from "obsidian";
import crypto from "crypto";

/** 语言代码映射：插件内部 → 百度 API */
const BAIDU_LANG: Record<string, string> = {
  zh: "zh", en: "en", ja: "jp", ko: "kor", fr: "fra", de: "de",
  es: "spa", pt: "pt", ru: "ru",
};

function md5(s: string): string {
  return crypto.createHash("md5").update(s, "utf-8").digest("hex");
}

/** 调用百度翻译 API，成功返回译文，失败返回 null（不抛错，上层兜底） */
export async function baiduTranslate(
  text: string, from: string, to: string,
  appId: string, key: string
): Promise<string | null> {
  if (!appId || !key || !text.trim()) return null;
  const salt = String(Math.floor(Math.random() * 1000000000000));
  const sign = md5(appId + text + salt + key);
  const body = `q=${encodeURIComponent(text)}&from=${BAIDU_LANG[from] || from}`
    + `&to=${BAIDU_LANG[to] || to}&appid=${appId}&salt=${salt}&sign=${sign}`;
  try {
    const resp = await requestUrl({
      url: "https://fanyi-api.baidu.com/api/trans/vip/translate",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      throw: false,
    });
    if (resp.status !== 200) return null;
    const data = resp.json as { error_code?: string; trans_result?: Array<{ dst: string }> } | undefined;
    if (!data || data.error_code) return null;
    const dst = data.trans_result?.map((t) => t.dst).join("\n");
    return dst || null;
  } catch { return null; }
}
