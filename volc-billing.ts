import { requestUrl } from "obsidian";

// 用 Node crypto（Electron 环境可用，与之前独立测试 200 通过的算法完全相同）
import crypto from "crypto";

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

/** HMAC-SHA256 返回 raw Buffer，用于密钥派生链 */
function hmacBuf(key: any, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}

/** HMAC-SHA256 返回 hex string（仅用于最终签名） */
function hmacHex(key: any, data: string): string {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest("hex");
}

// ---- 火山引擎 V4 签名 ----
const ALGORITHM = "HMAC-SHA256";

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
  const payloadHash = sha256Hex("");
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders =
    `content-type:application/x-www-form-urlencoded\n` +
    `host:${host}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${full}\n`;
  const canonicalRequest = ["GET", "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credScope = `${short}/${region}/${service}/request`;
  const stringToSign = [ALGORITHM, full, credScope, sha256Hex(canonicalRequest)].join("\n");

  const k1 = hmacBuf(sk, short);
  const k2 = hmacBuf(k1, region);
  const k3 = hmacBuf(k2, service);
  const k4 = hmacBuf(k3, "request");
  const signature = hmacHex(k4, stringToSign);

  const auth = `${ALGORITHM} Credential=${ak}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const crHash = sha256Hex(canonicalRequest);
  const stsHash = sha256Hex(stringToSign);
  console.debug("[volc signing]", { scope: credScope, crHash: crHash.slice(0, 12), stsHash: stsHash.slice(0, 12) });

  // fetch 优先，失败回退 requestUrl
  let status: number, json: any, err: string | undefined;
  try {
    const fr = await fetch(`https://${host}/?${query}`, {
      method: "GET",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Date": full, "X-Content-Sha256": payloadHash, Authorization: auth } as Record<string, string>,
    });
    status = fr.status;
    json = fr.ok ? await fr.json() : null;
    if (!fr.ok) { try { err = await fr.text(); } catch {} }
  } catch {
    const resp = await requestUrl({
      url: `https://${host}/?${query}`, method: "GET",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Date": full, "X-Content-Sha256": payloadHash, Authorization: auth },
      throw: false,
    });
    status = resp.status;
    json = resp.status === 200 ? resp.json : null;
    err = resp.status !== 200 ? (resp.json?.ResponseMetadata?.Error?.Message || resp.text?.slice(0, 200)) : undefined;
  }
  return { status, json, err };
}

/** 查询火山账户余额（元），失败返回 null */
export async function fetchVolcanoBalance(ak: string, sk: string): Promise<number | null> {
  try {
    const result = await signedGet("billing.volcengineapi.com", "billing", "cn-beijing",
      "Action=QueryBalanceAcct&Version=2022-01-01", ak, sk);
    if (result.status === 200 && result.json) {
      const v = parseFloat(result.json?.Result?.AvailableBalance ?? result.json?.Result?.CashBalance ?? "0");
      if (!isNaN(v)) return v;
    }
    return null;
  } catch { return null; }
}

/** 查询本月语音合成大模型官方用量（字符），失败/无数据返回 null */
export async function fetchVolcanoUsage(ak: string, sk: string, appId: string, start: string, end: string): Promise<number | null> {
  try {
    const q = `Action=UsageMonitoring&AppID=${appId}&End=${end}&Mode=daily&ResourceID=volc.seedtts.default&Start=${start}&Version=2021-08-30`;
    const result = await signedGet("open.volcengineapi.com", "speech_saas_prod", "cn-north-1", q, ak, sk);
    if (result.status !== 200 || !result.json || result.json?.status !== "success") return null;
    const um = result.json?.data?.usage_monitoring;
    if (!Array.isArray(um)) return null;
    return um.reduce((s: number, x: any) => s + (x.value || 0), 0);
  } catch { return null; }
}
