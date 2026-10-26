import type { FastifyInstance } from "fastify";
import { cfg } from "../config.ts";
import { streamChat, type Msg } from "../trae/chat.ts";

type Block = { type?: string; text?: string };
type AnthropicBody = {
  model?: string;
  system?: string | Block[];
  messages?: Array<{ role: string; content: string | Block[] }>;
  stream?: boolean;
  max_tokens?: number;
};

const textOf = (c: string | Block[] | undefined): string =>
  typeof c === "string" ? c : (c ?? []).map((p) => p?.text ?? "").join("");

export async function registerAnthropic(app: FastifyInstance) {
  app.post("/v1/messages", async (req, reply) => {
    const b = req.body as AnthropicBody;
    const model = b.model || cfg.defaultModel;
    const msgs: Msg[] = [];
    const sys = textOf(b.system);
    if (sys) msgs.push({ role: "system", content: sys });
    for (const m of b.messages ?? []) {
      msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) });
    }
    if (!msgs.length) return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "messages is required" } });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) =>
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const idx = { thinking: 0, text: 1 };
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    let block: "thinking" | "text" | null = null;

    try {
      send("message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      });
      for await (const d of streamChat(model, msgs)) {
        if (d.reasoning) {
          if (block !== "thinking") {
            if (block) send("content_block_stop", { type: "content_block_stop", index: idx.text });
            block = "thinking";
            send("content_block_start", { type: "content_block_start", index: idx.thinking, content_block: { type: "thinking", thinking: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: idx.thinking, delta: { type: "thinking_delta", thinking: d.reasoning } });
        }
        if (d.text) {
          if (block !== "text") {
            if (block) send("content_block_stop", { type: "content_block_stop", index: idx.thinking });
            block = "text";
            send("content_block_start", { type: "content_block_start", index: idx.text, content_block: { type: "text", text: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: idx.text, delta: { type: "text_delta", text: d.text } });
        }
        if (d.finishReason) {
          if (block) send("content_block_stop", { type: "content_block_stop", index: block === "thinking" ? idx.thinking : idx.text });
          send("message_delta", {
            type: "message_delta",
            delta: { stop_reason: d.finishReason === "length" ? "max_tokens" : "end_turn" },
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
