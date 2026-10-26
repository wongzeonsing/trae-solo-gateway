#!/usr/bin/env node
/** Real upstream probe: hits llm_utils_chat through the gateway's own client. */
import { cfg } from "../src/config.ts";
import { streamChat } from "../src/trae/chat.ts";

const model = process.argv[2] ?? cfg.defaultModel;
const prompt = process.argv[3] ?? "只回答两个字：收到";
let reasoning = 0;
let text = "";
let finish = "";
const t0 = Date.now();

for await (const d of streamChat(model, [{ role: "user", content: prompt }])) {
  if (d.reasoning) reasoning += d.reasoning.length;
  if (d.text) text += d.text;
  if (d.finishReason) finish = d.finishReason;
  if (d.usage) console.log("usage:", JSON.stringify(d.usage));
}
console.log(`model=${model} reasoning=${reasoning} chars text="${text}" finish=${finish} ${Date.now() - t0}ms`);
if (!text) {
  console.error("FAIL: empty response");
  process.exit(1);
}
