import { cfg, MODELS } from "../config.ts";
import { upstreamHeaders } from "./auth.ts";

/**
 * chat_v3 的 config 列表里混着内部功能（摘要/应用补丁/标题生成/输入优化），
 * 它们不是给用户选的对话模型。
 */
const INTERNAL = new Set(["summary", "fast_apply", "fast_apply_new", "title_generation", "input_optimization"]);

/** 缓存 6 小时；拉取失败或为空时永远回退 MODELS（人工验证过能跑的那批）。 */
const TTL_MS = 6 * 3600_000;
let cache: { at: number; models: string[] } | null = null;

export function currentModels(): string[] {
  return cache?.models.length ? cache.models : MODELS;
}

/** 拉上游模型目录：一次 228KB 的明文响应，只取 chat_v3 下用户可见的对话模型。 */
export async function refreshModels(): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(`${cfg.upstream}/api/ide/v1/batch_get_detail_param`, {
      method: "POST",
      headers: await upstreamHeaders(),
      body: JSON.stringify({ functions: [cfg.functionName] }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      function_configs?: Array<{ config_info_list?: Array<Record<string, unknown>> }>;
    };
    const list = data.function_configs?.[0]?.config_info_list ?? [];
    const live = list
      .filter((c) => !c.is_invisible_to_user)
      .map((c) => String(c.config_name ?? ""))
      .filter((n) => n && !n.startsWith("custom_model_") && !INTERNAL.has(n));
    if (!live.length) throw new Error("upstream returned no visible model");

    // 静态清单里的模型即使被上游隐藏也保留（它们已验证可跑），合并去重。
    const merged = [...new Set([...MODELS, ...live])];
    cache = { at: Date.now(), models: merged };
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 后台同步：启动即试一次，之后每小时检查 TTL。
 * 绝不能放在请求路径上——这个接口上游抽风时会挂很久。
 */
export function startModelSync(log: { info: (m: string) => void; warn: (m: string) => void }) {
  const tick = async () => {
    if (cache && Date.now() - cache.at < TTL_MS) return;
    try {
      const models = await refreshModels();
      log.info(`[models] synced ${models.length} from upstream`);
    } catch (e) {
      log.warn(`[models] sync failed, keeping ${currentModels().length}: ${(e as Error).message}`);
    }
  };
  void tick();
  setInterval(() => void tick(), 3600_000).unref();
}
