import { requestUrl } from "obsidian";

// ---- 火山引擎 V4 签名（billing 服务，查账户余额） ----
const SERVICE = "billing";
const REGION = "cn-beijing";
const HOST = "billing.volcengineapi.com";
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
  const full = `${short}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return { short, full };
}

/** 查询火山账户余额，返回数字（元）或 null */
export async function fetchVolcanoBalance(ak: string, sk: string): Promise<number | null> {
  if (!ak || !sk) return null;
  try {
    const { short, full } = amzDates();
    const query = "Action=QueryBalanceAcct&Version=2022-01-01";
    const payloadHash = await sha256Hex("");

    const signedHeaders = "content-type;host;x-content-sha256;x-date";
    const canonicalHeaders =
      `content-type:application/x-www-form-urlencoded; charset=utf-8\n` +
      `host:${HOST}\n` +
      `x-content-sha256:${payloadHash}\n` +
      `x-date:${full}\n`;

    const canonicalRequest = ["GET", "/", query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credScope = `${short}/${REGION}/${SERVICE}/request`;
    const stringToSign = [ALGORITHM, full, credScope, await sha256Hex(canonicalRequest)].join("\n");

    const kDate = await hmac("Volc" + sk, short);
    const kRegion = await hmac(kDate, REGION);
    const kService = await hmac(kRegion, SERVICE);
    const kSigning = await hmac(kService, "request");
    const signature = await sha256Hex(await hmac(kSigning, stringToSign));

    const resp = await requestUrl({
      url: `https://${HOST}/?${query}`,
      method: "GET",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-Date": full,
        "X-Content-Sha256": payloadHash,
        Authorization: `${ALGORITHM} Credential=${ak}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      throw: false,
    });
    if (resp.status !== 200) return null;

    // 兼容多种返回结构
    const result = resp.json?.Result;
    const infos = result?.BalanceInfos;
    if (Array.isArray(infos) && infos.length > 0) {
      const b = infos[0];
      const val = b.Balance ?? b.CashBalance ?? b.AvailableBalance;
      if (typeof val === "number") return val;
    }
    if (typeof result?.Balance === "number") return result.Balance;
    return null;
  } catch {
    return null;
  }
}
