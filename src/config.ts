const env = process.env;

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export const cfg = {
  host: env.HOST ?? "127.0.0.1",
  port: num(env.PORT, 19980),
  upstream: env.TRAE_UPSTREAM ?? "https://api5-normal.mchost.guru",
  /** Trae 登录态（只读）。默认指向 NAS 上已导出的那份。 */
  authFile: env.TRAE_AUTH_FILE ?? "./secrets/trae-auth.json",
  appId: env.TRAE_APP_ID ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  ideVersion: env.TRAE_IDE_VERSION ?? "3.4.4",
  /** 新模型的闸门：旧值会 4001 config item is empty。 */
  ideVersionCode: env.TRAE_IDE_VERSION_CODE ?? "20260924",
  functionName: env.TRAE_FUNCTION ?? "chat_v3",
  defaultModel: env.TRAE_DEFAULT_MODEL ?? "deepseek-v4.1-flash",
  /** 上游总超时（长任务可调）。 */
  timeoutMs: num(env.TRAE_TIMEOUT_MS, 120_000),
  /** 非空时所有 /v1/* 必须带 Authorization: Bearer <key> 或 x-api-key。 */
  apiKey: env.GATEWAY_KEY ?? "",
  logLevel: env.LOG_LEVEL ?? "info",
};

export const MODELS = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "glm-5.3",
  "Doubao-Seed-2.1-Pro",
  "Doubao-Seed-Code",
  "minimax-m2.1",
];
