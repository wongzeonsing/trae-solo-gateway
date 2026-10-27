#!/usr/bin/env node
/** 本地验收：网关三个面各打一发，断言有内容。 */
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 19900}`;
/** GATEWAY_KEY 非空时 /v1/* 需要鉴权；用 x-api-key 而不是 Authorization: Bearer。 */
const AUTH: Record<string, string> = process.env.GATEWAY_KEY ? { "x-api-key": process.env.GATEWAY_KEY } : {};

async function chat(stream: boolean) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", stream, messages: [{ role: "user", content: "只回答两个字：收到" }] }),
  });
  if (!r.ok) throw new Error(`chat ${r.status} ${await r.text()}`);
  if (!stream) {
    const j = (await r.json()) as any;
    return j.choices[0].message.content as string;
  }
  let out = "";
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const j = JSON.parse(line.slice(6));
      out += j.choices?.[0]?.delta?.content ?? "";
    }
    buf = "";
  }
  return out;
}

async function anthropic() {
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "deepseek-v4.1-flash", max_tokens: 32, stream: true, messages: [{ role: "user", content: "只回答两个字：收到" }] }),
  });
  const t = await r.text();
  if (!t.includes("content_block_delta")) throw new Error("anthropic: no content_block_delta");
  return "ok";
}

const models = await (await fetch(`${BASE}/v1/models`, { headers: AUTH })).json() as any;
assert(models.data.length > 0, "models empty");
const a = await chat(false);
assert(a.trim().length > 0, "non-stream empty");
const b = await chat(true);
assert(b.trim().length > 0, "stream empty");
const c = await anthropic();
console.log(`smoke ok  models=${models.data.length} nonstream="${a.trim()}" stream="${b.trim()}" anthropic=${c}`);

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}
