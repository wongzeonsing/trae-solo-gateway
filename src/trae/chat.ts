import { cfg } from "../config.ts";
import { upstreamHeaders } from "./auth.ts";
import { addUsage } from "../console/stats.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type Msg = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** assistant 回合里模型要求调用的工具 */
  tool_calls?: ToolCall[];
  /** role=tool 时对应哪个调用 */
  tool_call_id?: string;
};

/** OpenAI tools 定义，原样收下（上游要求 parameters 是 JSON 字符串，发送时再串化）。 */
export type ToolDef = { type: "function"; function: { name: string; description?: string; parameters?: unknown } };

/** 与 OpenAI 流式 delta.tool_calls 同构：index 定位，arguments 为增量。 */
export type ToolCallDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

export type Delta = {
  /** 正文增量 */
  text?: string;
  /** 思考链增量 */
  reasoning?: string;
  toolCalls?: ToolCallDelta[];
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; reasoning_tokens?: number };
};

type OutputPayload = {
  response?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function_call?: { name?: string; arguments?: string } | null;
  }> | null;
};

export type ChatOpts = {
  /** OpenAI 的五档映射到 Trae 的三档（light/high/extra_high）。 */
  reasoningEffort?: string;
  tools?: ToolDef[];
  toolChoice?: string;
};

const EFFORT: Record<string, "light" | "high" | "extra_high"> = {
  minimal: "light",
  low: "light",
  medium: "high",
  high: "high",
  xhigh: "extra_high",
  max: "extra_high",
  ultra: "extra_high",
};

export function mapEffort(v?: string): "light" | "high" | "extra_high" | undefined {
  if (!v) return undefined;
  return EFFORT[v.toLowerCase()] ?? (["light", "high", "extra_high"].includes(v.toLowerCase()) ? (v.toLowerCase() as never) : undefined);
}

/** 上游 messages：assistant 带 tool_calls、tool 带 tool_call_id，其余走文本块。 */
function toUpstreamMessages(messages: Msg[]) {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: [{ type: "text", text: m.content }] };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        tool_calls: m.tool_calls.map((t) => ({
          id: t.id,
          type: t.type,
          function_call: { name: t.function.name, arguments: t.function.arguments },
        })),
      };
    }
    return { role: m.role, content: [{ type: "text", text: m.content }] };
  });
}

/** 上游要求 parameters 是字符串（Go FunctionDefinition.parameters string）。 */
function toUpstreamTools(tools?: ToolDef[]) {
  return tools?.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: typeof t.function.parameters === "string" ? t.function.parameters : JSON.stringify(t.function.parameters ?? {}),
    },
  }));
}

let specialHits = 0;

/**
 * 诊断：上游把特殊 token 文本化后（全角竖线 ｜ / 下划线 ▁）会以可见字符进入正文，
 * OpenAI 兼容客户端不认识，只会原样显示。这里只记录原始片段，不改写输出。
 */
function traceSpecial(text: string, model: string) {
  if (specialHits >= 5 || !/[｜▁]/.test(text)) return;
  specialHits++;
  console.warn(`[special-token] model=${model} raw=${JSON.stringify(text.slice(0, 200))}`);
}

/**
 * POST /api/agent/v3/llm_utils_chat，把上游 SSE 归一化成增量。
 * 上游事件：metadata / timing_cost / output / extra_info / token_usage / done / error。
 * 注意 HTTP 200 + event:error 是失败（聊天通道也会这样）。
 */
export async function* streamChat(
  model: string,
  messages: Msg[],
  opts: ChatOpts = {},
  signal?: AbortSignal,
): AsyncGenerator<Delta> {
  const effort = mapEffort(opts.reasoningEffort);
  const tools = toUpstreamTools(opts.tools);
  const body = {
    function: cfg.functionName,
    config_name: model,
    model,
    stream: true,
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(tools?.length ? { tools, ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}) } : {}),
    messages: toUpstreamMessages(messages),
  };

  if (process.env.TRAE_DUMP === "1") {
    console.log(`[dump] body=${JSON.stringify(body).slice(0, 1200)}`);
  }

  const url = `${cfg.upstream}/api/agent/v3/llm_utils_chat`;
  const headers = await upstreamHeaders();
  const payload = JSON.stringify(body);

  // 建流阶段可重试：此时还没往外 yield 任何增量，重来一遍是安全的。
  // 流一旦开始就不能重试（客户端已收到前半段）；客户端主动取消也不重试。
  let res: Response | undefined;
  let ac: AbortController | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= cfg.retryAttempts; attempt++) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(new Error("client closed"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const total = setTimeout(() => ctrl.abort(new Error("upstream total timeout")), cfg.timeoutMs);
    const header = setTimeout(() => ctrl.abort(new Error("upstream header timeout")), cfg.headerTimeoutMs);
    try {
      const r = await fetch(url, { method: "POST", headers, body: payload, signal: ctrl.signal });
      clearTimeout(header);
      if (!r.ok || !r.body) {
        const text = await r.text().catch(() => "");
        throw new UpstreamError(r.status, text.slice(0, 800));
      }
      res = r;
      ac = ctrl;
      totalTimer = total;
      detach = () => signal?.removeEventListener("abort", onAbort);
      break;
    } catch (e) {
      clearTimeout(header);
      clearTimeout(total);
      signal?.removeEventListener("abort", onAbort);
      // 客户端取消、或 4xx（429 除外）重试也没用
      if (signal?.aborted) throw e;
      if (e instanceof UpstreamError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      if (attempt < cfg.retryAttempts) {
        await new Promise((r) => setTimeout(r, cfg.retryBackoffMs * attempt));
      }
    }
  }
  if (!res || !ac) throw lastErr ?? new UpstreamError(504, "upstream unavailable");

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // 空闲超时：每收到一块数据就重置，专门抓「流到一半不动了」。
  let idle = setTimeout(() => ac!.abort(new Error("upstream idle timeout")), cfg.idleTimeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => ac!.abort(new Error("upstream idle timeout")), cfg.idleTimeoutMs);
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseBlock(block);
        if (!ev) continue;
        if (ev.event === "output") {
          const p = JSON.parse(ev.data) as OutputPayload;
          const text = p.response ?? undefined;
          const reasoning = p.reasoning_content ?? undefined;
          if (text) traceSpecial(text, model);
          const toolCalls = (p.tool_calls ?? [])?.map((t, i) => ({
            index: t.index ?? i,
            ...(t.id ? { id: t.id } : {}),
            ...(t.type ? { type: t.type } : {}),
            ...(t.function_call
              ? {
                  function: {
                    ...(t.function_call.name ? { name: t.function_call.name } : {}),
                    ...(t.function_call.arguments ? { arguments: t.function_call.arguments } : {}),
                  },
                }
              : {}),
          }));
          if (text || reasoning || toolCalls?.length) {
            yield {
              ...(text ? { text } : {}),
              ...(reasoning ? { reasoning } : {}),
              ...(toolCalls?.length ? { toolCalls } : {}),
            };
          }
        } else if (ev.event === "token_usage") {
          const u = JSON.parse(ev.data) as Record<string, number>;
          addUsage(model, {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            reasoning_tokens: u.reasoning_tokens,
          });
          yield {
            usage: {
              prompt_tokens: u.prompt_tokens ?? 0,
              completion_tokens: u.completion_tokens ?? 0,
              total_tokens: u.total_tokens ?? 0,
              reasoning_tokens: u.reasoning_tokens,
            },
          };
        } else if (ev.event === "done") {
          const d = JSON.parse(ev.data) as { finish_reason?: string };
          yield { finishReason: d.finish_reason ?? "stop" };
        } else if (ev.event === "error") {
          const e = JSON.parse(ev.data) as { code?: number; message?: string };
          throw new UpstreamError(502, `upstream error ${e.code ?? ""}: ${e.message ?? ev.data}`);
        }
      }
    }
  } finally {
    clearTimeout(idle);
    clearTimeout(totalTimer);
    detach?.();
    reader.cancel().catch(() => {});
  }
}

function parseBlock(block: string): { event: string; data: string } | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!event || !dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

export class UpstreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "UpstreamError";
  }
}
