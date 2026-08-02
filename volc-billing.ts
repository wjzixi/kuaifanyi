import { requestUrl } from "obsidian";

// 用 Node crypto（Electron 环境可用，与之前独立测试 200 通过的算法完全相同）
import crypto from "crypto";

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

/** HMAC-SHA256 返回 raw Buffer，用于密钥派生链 */
function hmacBuf(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}

/** HMAC-SHA256 返回 hex string（仅用于最终签名） */
function hmacHex(key: string | Buffer, data: string): string {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest("hex");
}

// ---- 火山引擎 V4 签名 ----
const ALGORITHM = "HMAC-SHA256";

/** 火山 API 错误元数据（非 200 响应体） */
type VolcErrorResp = { ResponseMetadata?: { Error?: { Message?: string } } };

function amzDates(): { short: string; full: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const short = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  return { short, full: `${short}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z` };
}

async function signedGet(
  host: string, service: string, region: string,
  query: string, ak: string, sk: string
): Promise<{ status: number; json: unknown; err?: string }> {
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

  // requestUrl 官方网络栈（throw:false 时仅网络层错误才抛异常，HTTP 错误走 status）
  let status = 500, err: string | undefined;
  let json: unknown = null;
  try {
    const resp = await requestUrl({
      url: `https://${host}/?${query}`, method: "GET",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Date": full, "X-Content-Sha256": payloadHash, Authorization: auth },
      throw: false,
    });
    status = resp.status;
    const text = resp.text ?? "";
    let parsed: VolcErrorResp | null = null;
    try { parsed = JSON.parse(text) as VolcErrorResp; } catch { /* 非 JSON 响应体 */ }
    json = resp.status === 200 ? parsed : null;
    err = resp.status !== 200 ? (parsed?.ResponseMetadata?.Error?.Message ?? text.slice(0, 200)) : undefined;
  } catch { /* 网络层失败，按 status 500 返回 */ }
  return { status, json, err };
}

/** 查询火山账户余额（元），失败返回 null */
export async function fetchVolcanoBalance(ak: string, sk: string): Promise<number | null> {
  try {
    const result = await signedGet("billing.volcengineapi.com", "billing", "cn-beijing",
      "Action=QueryBalanceAcct&Version=2022-01-01", ak, sk);
    if (result.status === 200 && result.json) {
      const r = result.json as { Result?: { AvailableBalance?: string; CashBalance?: string } };
      const v = parseFloat(r.Result?.AvailableBalance ?? r.Result?.CashBalance ?? "0");
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
    if (result.status !== 200 || !result.json) return null;
    // V4 签名响应没有顶层 status，数据直接在 data.usage_monitoring
    const um = (result.json as { data?: { usage_monitoring?: Array<{ day?: string; value?: number }> } })?.data?.usage_monitoring;
    if (!Array.isArray(um)) return null;
    return um.reduce((s: number, x: { value?: number }) => s + (x.value || 0), 0);
  } catch { return null; }
}

// ---- 阿里云 BSS 余额查询 ----
function aliyunSign(params: Record<string, string>, method: string, sk: string): string {
  const sortedKeys = Object.keys(params).sort();
  const canonQuery = sortedKeys.map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
  const stringToSign = method + "&" + encodeURIComponent("/") + "&" + encodeURIComponent(canonQuery);
  const hmac = crypto.createHmac("sha1", sk + "&");
  const sig = hmac.update(stringToSign, "utf-8").digest("base64");
  return canonQuery + "&Signature=" + encodeURIComponent(sig);
}

export async function fetchAliyunBalance(ak: string, sk: string): Promise<number | null> {
  try {
    const params: Record<string, string> = {
      Action: "QueryAccountBalance", Version: "2017-12-14",
      AccessKeyId: ak, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      Format: "JSON", SignatureNonce: crypto.randomUUID(),
    };
    const query = aliyunSign(params, "GET", sk);
    const resp = await requestUrl({ url: "https://business.aliyuncs.com/?" + query, method: "GET", throw: false });
    if (resp.status !== 200) return null;
    const d = resp.json as { Data?: { AvailableAmount?: string } } | undefined;
    const v = parseFloat(d?.Data?.AvailableAmount || "0");
    return isNaN(v) ? null : v;
  } catch { return null; }
}
