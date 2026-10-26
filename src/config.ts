const env = process.env;

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

export const cfg = {
  host: env.HOST ?? "127.0.0.1",
  port: num(env.PORT, 19900),
  upstream: env.TRAE_UPSTREAM ?? "https://api5-normal.mchost.guru",
  /** Trae 登录态（只读）。默认指向导出的 auth 文件。 */
  authFile: env.TRAE_AUTH_FILE ?? "./secrets/trae-auth.json",
  appId: env.TRAE_APP_ID ?? "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  ideVersion: env.TRAE_IDE_VERSION ?? "3.4.4",
  /** 新模型的闸门：旧值会 4001 config item is empty。 */
  ideVersionCode: env.TRAE_IDE_VERSION_CODE ?? "20260924",
  functionName: env.TRAE_FUNCTION ?? "chat_v3",
  defaultModel: env.TRAE_DEFAULT_MODEL ?? "deepseek-v4.1-flash",
  /** 上游总超时（长任务可调），覆盖整轮请求。 */
  timeoutMs: num(env.TRAE_TIMEOUT_MS, 120_000),
  /** 等响应头/首字节的上限：卡在这里通常是上游过载或排队。 */
  headerTimeoutMs: num(env.TRAE_HEADER_TIMEOUT_MS, 60_000),
  /** 流中间空闲上限：收到数据就重置，用来抓「流了一半不动了」。 */
  idleTimeoutMs: num(env.TRAE_IDLE_TIMEOUT_MS, 90_000),
  /** 仅在建流阶段重试（流一旦开始就无法回放），客户端主动取消不重试。 */
  retryAttempts: num(env.TRAE_RETRY_ATTEMPTS, 2),
  retryBackoffMs: num(env.TRAE_RETRY_BACKOFF_MS, 800),
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
