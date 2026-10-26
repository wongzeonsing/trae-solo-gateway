import type { FastifyInstance } from "fastify";
import { cfg } from "../config.ts";
import { streamChat, type Msg, type ToolCall, type ToolCallDelta, type ToolDef } from "../trae/chat.ts";

type ABlock = {
  type?: string;
  text?: string;
  // tool_use（assistant 发出）
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result（user 回传）
  tool_use_id?: string;
  content?: unknown;
};
type AMessage = { role?: string; content?: string | ABlock[] };
type ATool = { name?: string; description?: string; input_schema?: unknown };
type AnthropicBody = {
  model?: string;
  system?: string | ABlock[];
  messages?: AMessage[];
  stream?: boolean;
  max_tokens?: number;
  tools?: ATool[];
};

const textOf = (c: string | ABlock[] | undefined): string =>
  typeof c === "string" ? c : (c ?? []).map((p) => (p?.type ?? "text") === "text" ? (p.text ?? "") : "").join("");

/** tool_result.content 可以是字符串，也可以是 [{type:'text',text}] 数组 */
const resultText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x as ABlock)?.text ?? "").join("") : JSON.stringify(c ?? "");

const newId = () => `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

/**
 * Anthropic → 内部消息。
 * 关键：一条 user 消息里同时带 tool_result 和文本时，tool_result 必须排在前面，
 * 否则上游会把它当成新的用户发言（客户端也会拒）。
 */
function toMsgs(b: AnthropicBody): Msg[] {
  const out: Msg[] = [];
  const sys = textOf(b.system);
  if (sys) out.push({ role: "system", content: sys });

  for (const m of b.messages ?? []) {
    const blocks: ABlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "assistant") {
      const text = textOf(blocks);
      const uses = blocks.filter((x) => x?.type === "tool_use");
      if (uses.length) {
        out.push({
          role: "assistant",
          content: text,
          tool_calls: uses.map((u, i) => ({
            id: u.id || `call_${i}`,
            type: "function" as const,
            function: { name: u.name ?? "", arguments: JSON.stringify(u.input ?? {}) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: text });
      }
      continue;
    }
    for (const r of blocks.filter((x) => x?.type === "tool_result")) {
      out.push({ role: "tool", content: resultText(r.content), tool_call_id: r.tool_use_id ?? "" });
    }
    const text = textOf(blocks);
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const toTools = (tools?: ATool[]): ToolDef[] | undefined => {
  const mapped = (tools ?? [])
    .filter((t) => t?.name)
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name as string,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  return mapped.length ? mapped : undefined;
};

const collect = (acc: Map<number, ToolCall>, deltas: ToolCallDelta[]) => {
  for (const d of deltas) {
    const prev = acc.get(d.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
    acc.set(d.index, {
      id: d.id || prev.id || newId(),
      type: "function",
      function: {
        name: d.function?.name || prev.function.name,
        arguments: prev.function.arguments + (d.function?.arguments ?? ""),
      },
    });
  }
};

const parseArgs = (s: string): unknown => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

const stopReason = (finish: string, hasTools: boolean): string =>
  hasTools || finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";

export async function registerAnthropic(app: FastifyInstance) {
  app.post("/v1/messages", async (req, reply) => {
    const b = req.body as AnthropicBody;
    const model = b.model || cfg.defaultModel;
    const msgs = toMsgs(b);
    const tools = toTools(b.tools);
    if (!msgs.length) {
      return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "messages is required" } });
    }

    const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

    // 非流式：Anthropic 客户端在 stream=false 时等一个完整 message 对象。
    if (b.stream === false) {
      let text = "";
      let thinking = "";
      let finish = "end_turn";
      const calls = new Map<number, ToolCall>();
      try {
        for await (const d of streamChat(model, msgs, { tools })) {
          if (d.text) text += d.text;
          if (d.reasoning) thinking += d.reasoning;
          if (d.toolCalls) collect(calls, d.toolCalls);
          if (d.finishReason) finish = d.finishReason;
        }
      } catch (e) {
        return reply.code(502).send({ type: "error", error: { type: "api_error", message: String((e as Error).message) } });
      }
      const toolCalls = [...calls.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
      const content: unknown[] = [];
      if (thinking) content.push({ type: "thinking", thinking });
      if (text) content.push({ type: "text", text });
      for (const t of toolCalls) {
        content.push({ type: "tool_use", id: t.id || newId(), name: t.function.name, input: parseArgs(t.function.arguments) });
      }
      return reply.send({
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: stopReason(finish, toolCalls.length > 0),
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let blockIndex = -1;
    // 放在对象里持有：闭包里赋值时 TS 的控制流分析看不到，直接用变量会被收窄成 null。
    const st: { open: { idx: number; kind: "thinking" | "text" | "tool" } | null } = { open: null };
    const closeBlock = () => {
      if (st.open) {
        send("content_block_stop", { type: "content_block_stop", index: st.open.idx });
        st.open = null;
      }
    };
    const startBlock = (kind: "thinking" | "text" | "tool", content_block: Record<string, unknown>) => {
      closeBlock();
      blockIndex++;
      st.open = { idx: blockIndex, kind };
      send("content_block_start", { type: "content_block_start", index: blockIndex, content_block });
    };

    // 工具调用先累积、流结束后统一发：上游的并行调用增量是交错的，
    // 而 Anthropic 流式同一时刻只能有一个 open block，逐包发会串块。
    const calls = new Map<number, ToolCall>();
    let sawTool = false;

    try {
      send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      for await (const d of streamChat(model, msgs, { tools }, abortOnClose(raw))) {
        if (d.reasoning) {
          if (st.open?.kind !== "thinking") startBlock("thinking", { type: "thinking", thinking: "" });
          send("content_block_delta", {
            type: "content_block_delta",
            index: st.open!.idx,
            delta: { type: "thinking_delta", thinking: d.reasoning },
          });
        }
        if (d.text) {
          if (st.open?.kind !== "text") startBlock("text", { type: "text", text: "" });
          send("content_block_delta", {
            type: "content_block_delta",
            index: st.open!.idx,
            delta: { type: "text_delta", text: d.text },
          });
        }
        if (d.toolCalls?.length) {
          sawTool = true;
          collect(calls, d.toolCalls);
        }
        if (d.finishReason) {
          closeBlock();
          for (const [, t] of [...calls.entries()].sort((x, y) => x[0] - y[0])) {
            startBlock("tool", { type: "tool_use", id: t.id || newId(), name: t.function.name, input: {} });
            const args = t.function.arguments || "{}";
            send("content_block_delta", {
              type: "content_block_delta",
              index: st.open!.idx,
              delta: { type: "input_json_delta", partial_json: args },
            });
            closeBlock();
          }
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason(d.finishReason, sawTool), stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          send("message_stop", { type: "message_stop" });
        }
      }
    } catch (e) {
      send("error", { type: "error", error: { type: "api_error", message: String((e as Error).message) } });
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
