import { readFile, writeFile, rename, chmod, stat } from "node:fs/promises";
import { cfg } from "../config.ts";

export type TraeAuth = {
  token: string;
  userId?: string;
  deviceId?: string;
  machineId?: string;
  expiredAt?: string;
};

type Raw = Record<string, unknown>;
let cache: { mtimeMs: number; auth: TraeAuth; raw: Raw } | null = null;
let inflight: Promise<TraeAuth> | null = null;

/** Token 剩余寿命低于这个值就去换新的（默认 30 分钟，与旧代理一致；可调）。 */
const REFRESH_SKEW_MS = Number(process.env.TRAE_REFRESH_SKEW_MS ?? 30 * 60 * 1000);
const AUTH_HOST = process.env.TRAE_AUTH_HOST ?? "https://api.trae.cn";

function jwtExpMs(token: string): number | null {
  try {
    const p = token.split(".")[1];
    if (!p) return null;
    const claims = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function pick(raw: Raw): TraeAuth {
  const token = String(raw.token ?? "");
  if (!token) throw new Error(`auth file has no token: ${cfg.authFile}`);
  return {
    token,
    userId: String(raw.userId ?? ""),
    deviceId: String(raw.deviceId ?? ""),
    machineId: String(raw.machineId ?? ""),
    expiredAt: raw.expiredAt ? String(raw.expiredAt) : undefined,
  };
}

/** ExchangeToken：CN 版唯一可行的自动续期链路（不需要设备证明）。
 *  响应包在 Result 里，且每次调用都会轮换 RefreshToken —— 必须写回，否则下次续不上。 */
async function exchange(refreshToken: string): Promise<Raw> {
  const res = await fetch(`${AUTH_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ClientID: process.env.TRAE_OAUTH_CLIENT_ID ?? "ono9krqynydwx5",
      RefreshToken: refreshToken,
      ClientSecret: process.env.TRAE_OAUTH_CLIENT_SECRET ?? "-",
      UserID: "",
    }),
  });
  if (!res.ok) throw new Error(`ExchangeToken ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { Result?: Raw } & Raw;
  const r = (body.Result ?? body) as Raw;
  const token = String(r.Token ?? "");
  if (!token) throw new Error(`ExchangeToken returned no Token (keys: ${Object.keys(r).join(",")})`);
  return {
    token,
    refreshToken: r.RefreshToken,
    expiredAt: r.TokenExpireAt ? new Date(Number(r.TokenExpireAt)).toISOString() : undefined,
    refreshExpiredAt: r.RefreshExpireAt ? new Date(Number(r.RefreshExpireAt)).toISOString() : undefined,
  };
}

/** 写回 auth 文件：保留 deviceId/machineId/privateKeyPEM 等原字段，原子替换。 */
async function persist(raw: Raw, next: Raw): Promise<void> {
  const merged: Raw = {
    ...raw,
    token: next.token,
    refreshToken: next.refreshToken ?? raw.refreshToken,
    expiredAt: next.expiredAt ?? raw.expiredAt,
    refreshExpiredAt: next.refreshExpiredAt ?? raw.refreshExpiredAt,
    tokenReleaseAt: next.tokenReleaseAt ?? raw.tokenReleaseAt,
  };
  const mode = (await stat(cfg.authFile)).mode & 0o777;
  const tmp = `${cfg.authFile}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await chmod(tmp, mode);
  await rename(tmp, cfg.authFile);
}

async function refresh(): Promise<TraeAuth> {
  if (inflight) return inflight;
  inflight = (async () => {
    const raw = cache!.raw;
    const expMs = jwtExpMs(cache!.auth.token);
    if (!expMs || expMs - Date.now() > REFRESH_SKEW_MS) return cache!.auth;

    const rt = String(raw.refreshToken ?? "");
    if (!rt) {
      console.warn("[auth] token expiring but no refreshToken; re-export from the IDE");
      return cache!.auth;
    }
    try {
      const next = await exchange(rt);
      await persist(raw, next).catch((e) => console.warn(`[auth] refreshed in memory, write-back failed: ${e.message}`));
      const merged = { ...raw, ...next };
      cache = { mtimeMs: (await stat(cfg.authFile)).mtimeMs, auth: pick(merged), raw: merged };
      console.log(`[auth] token refreshed, new expiry ${String(next.expiredAt ?? "?")}`);
      return cache.auth;
    } catch (e) {
      console.error(`[auth] refresh failed: ${(e as Error).message}`);
      return cache!.auth;
    }
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 读登录态；快到期的自动续期。文件被外部改动则重读。 */
export async function getAuth(): Promise<TraeAuth> {
  const { mtimeMs } = await stat(cfg.authFile);
  if (!cache || cache.mtimeMs !== mtimeMs) {
    const raw = JSON.parse(await readFile(cfg.authFile, "utf8")) as Raw;
    cache = { mtimeMs, auth: pick(raw), raw };
  }
  return refresh();
}

/** IDE 真实请求头集合（取自抓包；token 之外的字段服务端基本都校验得很松）。 */
export async function upstreamHeaders(): Promise<Record<string, string>> {
  const a = await getAuth();
  const trace = crypto.randomUUID().replace(/-/g, "");
  return {
    "content-type": "application/json",
    "request-traffic-type": "prod",
    "user-agent": "TraeClient/TTNet",
    "x-agent-host-type": "0",
    "x-app-id": cfg.appId,
    "x-app-version": "default",
    "x-app-version-code": cfg.ideVersionCode,
    "x-bridge-transport": "aha",
    "x-custom-trace-id": trace,
    "x-device-brand": "MacBookPro18,3",
    "x-device-cpu": "Apple",
    "x-device-id": a.deviceId || "2731658870026558",
    "x-device-type": "mac",
    "x-flow-traceparent": `04-${trace}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}-01`,
    "x-ide-token": a.token,
    "x-ide-version": cfg.ideVersion,
    "x-ide-version-code": cfg.ideVersionCode,
    "x-ide-version-type": "stable",
    "x-lgw-req-sdk-type": "3",
    "x-machine-id": a.machineId || "",
    "x-os-version": "macOS 27.0.1",
    "package-type": "stable_cn",
    "x-request-id": `req_${crypto.randomUUID()}`,
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": "mac",
    "X-SS-DP": "787976",
    accept: "*/*",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
  };
}
