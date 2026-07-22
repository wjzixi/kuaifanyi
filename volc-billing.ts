import { requestUrl } from "obsidian";

// ---- 火山引擎 V4 签名（对齐官方 SDK：SK 直接派生，不加前缀） ----
const ALGORITHM = "HMAC-SHA256";

async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const keyBuf = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data));
}

function amzDates(): { short: string; full: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const short = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return { short, full: `${short}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z` };
}

async function signedGet(
  host: string, service: string, region: string,
  query: string, ak: string, sk: string
): Promise<{ status: number; json: any; err?: string }> {
  const { short, full } = amzDates();
  const payloadHash = await sha256Hex("");
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalHeaders =
    `host:${host}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${full}\n`;
  const canonicalRequest = ["GET", "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credScope = `${short}/${region}/${service}/request`;
  const stringToSign = [ALGORITHM, full, credScope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(sk, short);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "request");
  const signature = await sha256Hex(await hmac(kSigning, stringToSign));

  const resp = await requestUrl({
    url: `https://${host}/?${query}`,
    method: "GET",
    headers: {
      "X-Date": full,
      "X-Content-Sha256": payloadHash,
      Authorization: `${ALGORITHM} Credential=${ak}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    throw: false,
  });
  const json = resp.status === 200 ? resp.json : null;
  return { status: resp.status, json, err: resp.status !== 200 ? (json?.ResponseMetadata?.Error?.Message || resp.text?.slice(0, 200)) : undefined };
}

/** 查询火山账户余额（元），失败返回 null，同时用 Notice 报告错误码 */
export async function fetchVolcanoBalance(ak: string, sk: string): Promise<number | null> {
  try {
    const result = await signedGet(
      "billing.volcengineapi.com", "billing", "cn-beijing",
      "Action=QueryBalanceAcct&Version=2022-01-01", ak, sk
    );
    if (result.status !== 200 || !result.json) {
      console.error("火山余额查询失败", result.status, result.err);
      return null;
    }
    const r = result.json?.Result;
    if (!r) return null;
    const v = parseFloat(r.AvailableBalance ?? r.CashBalance ?? "0");
    return isNaN(v) ? null : v;
  } catch { return null; }
}

/** 查询本月语音合成大模型官方用量（字符），失败/无数据返回 null */
export async function fetchVolcanoUsage(
  ak: string, sk: string, appId: string, start: string, end: string
): Promise<number | null> {
  try {
    const q =
      `Action=UsageMonitoring&AppID=${appId}&End=${end}&Mode=daily` +
      `&ResourceID=volc.service_type.10029&Start=${start}&Version=2021-08-30`;
    const result = await signedGet(
      "open.volcengineapi.com", "speech_saas_prod", "cn-north-1", q, ak, sk
    );
    if (result.status !== 200 || !result.json) return null;
    if (result.json?.status !== "success") return null;
    const um = result.json?.data?.usage_monitoring;
    if (!Array.isArray(um)) return null;
    return um.reduce((sum: number, x: any) => sum + (x.value || 0), 0);
  } catch { return null; }
}
