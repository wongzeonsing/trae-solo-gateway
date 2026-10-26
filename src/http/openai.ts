import type { FastifyInstance } from "fastify";
import { cfg } from "../config.ts";
import { streamChat, type Msg, type ToolCall, type ToolCallDelta, type ToolDef } from "../trae/chat.ts";
import { currentModels } from "../trae/models.ts";

/** 上游对未开通/已下架/当前不可用的模型一律只回一个码，补一句人话。 */
const explain = (m: string) =>
  /\b1005\b/.test(m)
    ? `${m.trim()}（该模型当前不可用：可能未开通、额度不足或已下线）`
    : /4001|param is invalid/.test(m)
      ? `${m}（该模型可能未开通或已下架）`
      : m;

type OpenAIToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type OpenAIMessage = {
  role: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

const textOf = (c: OpenAIMessage["content"]): string =>
  typeof c === "string" ? c : (c ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).join("");

export function toMsgs(messages: OpenAIMessage[]): Msg[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: textOf(m.content), tool_call_id: m.tool_call_id ?? "" } as Msg;
    }
    const base = { content: textOf(m.content) };
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        ...base,
        tool_calls: m.tool_calls.map((t, i) => ({
          id: t.id ?? `call_${i}`,
          type: "function" as const,
          function: { name: t.function?.name ?? "", arguments: t.function?.arguments ?? "{}" },
        })),
      } as Msg;
    }
    const role = m.role === "system" || m.role === "assistant" ? m.role : "user";
    return { role, ...base } as Msg;
  });
}

/** 把上游的 tool_calls 增量按 index 累加成完整调用。 */
function collectToolCalls(acc: Map<number, ToolCall>, deltas: ToolCallDelta[]) {
  for (const d of deltas) {
    const prev = acc.get(d.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
    acc.set(d.index, {
      id: d.id || prev.id,
      type: "function",
      function: {
        name: d.function?.name || prev.function.name,
        arguments: prev.function.arguments + (d.function?.arguments ?? ""),
      },
    });
  }
}

const id = () => `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export async function registerOpenAI(app: FastifyInstance) {
  app.get("/v1/models", async () => ({
    object: "list",
    data: currentModels().map((m) => ({ id: m, object: "model", created: 0, owned_by: "trae" })),
  }));

  app.post("/v1/chat/completions", async (req, reply) => {
    const b = req.body as {
      model?: string;
      messages?: OpenAIMessage[];
      stream?: boolean;
      reasoning_effort?: string;
      tools?: ToolDef[];
      tool_choice?: string;
    };
    const model = b.model || cfg.defaultModel;
    const messages = toMsgs(b.messages ?? []);
    const opts = { reasoningEffort: b.reasoning_effort, tools: b.tools, toolChoice: b.tool_choice };
    if (!messages.length) return reply.code(400).send({ error: { message: "messages is required" } });

    if (!b.stream) {
      // 非流式：避免长请求被中间设备判超时。
      // 先发 chunked 头、每 8s 写一个换行保活；JSON 解析容忍前导空白。
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
      const beat = setInterval(() => raw.write("\n"), 8_000);
      let text = "";
      let reasoning = "";
      let finish = "stop";
      let usage: Record<string, number> | undefined;
      const calls = new Map<number, ToolCall>();
      try {
        for await (const d of streamChat(model, messages, opts)) {
          if (d.text) text += d.text;
          if (d.reasoning) reasoning += d.reasoning;
          if (d.toolCalls) collectToolCalls(calls, d.toolCalls);
          if (d.finishReason) finish = d.finishReason;
          if (d.usage) usage = d.usage as unknown as Record<string, number>;
        }
        const toolCalls = [...calls.entries()].sort((a, b2) => a[0] - b2[0]).map(([, v]) => v);
        raw.write(
          JSON.stringify({
            id: id(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: text || (toolCalls.length ? null : ""),
                  ...(reasoning ? { reasoning_content: reasoning } : {}),
                  ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: toolCalls.length ? "tool_calls" : finish,
              },
            ],
            ...(usage ? { usage } : {}),
          }),
        );
      } catch (e) {
        // 头已发出，只能把错误放进 body（OpenAI 兼容形状）。
        raw.write(JSON.stringify({ error: { message: explain(String((e as Error)?.message ?? e)), type: "upstream_error" } }));
      } finally {
        clearInterval(beat);
        raw.end();
      }
      return reply;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const cid = id();
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      raw.write(
        `data: ${JSON.stringify({
          id: cid,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`,
      );
    try {
      chunk({ role: "assistant" });
      let sawToolCall = false;
      for await (const d of streamChat(model, messages, opts, abortOnClose(raw))) {
        if (d.reasoning) chunk({ reasoning_content: d.reasoning });
        if (d.text) chunk({ content: d.text });
        if (d.toolCalls?.length) {
          sawToolCall = true;
          chunk({ tool_calls: d.toolCalls });
        }
        if (d.usage) chunk({}, null, { usage: d.usage });
        if (d.finishReason) chunk({}, sawToolCall ? "tool_calls" : d.finishReason);
      }
      raw.write("data: [DONE]\n\n");
    } catch (e) {
      raw.write(`data: ${JSON.stringify({ error: { message: explain(String((e as Error).message)) } })}\n\n`);
    } finally {
      raw.end();
    }
    return reply;
  });
}

function abortOnClose(raw: import("node:http").ServerResponse): AbortSignal {
  const ac = new AbortController();
  raw.on("close", () => ac.abort(new Error("client closed")));
  return ac.signal;
}
