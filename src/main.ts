import Fastify from "fastify";
import { cfg } from "./config.ts";
import { registerOpenAI } from "./http/openai.ts";
import { registerAnthropic } from "./http/anthropic.ts";
import { getAuth } from "./trae/auth.ts";
import { startModelSync } from "./trae/models.ts";
import { registerConsole } from "./http/console.ts";
import { beginRequest, endRequest } from "./console/stats.ts";

const app = Fastify({ logger: { level: cfg.logLevel }, disableRequestLogging: true });

app.addHook("onRequest", (req, reply, done) => {
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 48);
  const via = String(req.headers["x-forwarded-for"] ?? req.ip);
  app.log.info({ u: req.url, ua, via }, "req");
  const rec = beginRequest(req.url, ua, via);
  const t0 = Date.now();
  reply.raw.on("close", () => {
    endRequest(rec, reply.raw.statusCode, Date.now() - t0);
    app.log.info({ u: req.url, s: reply.raw.statusCode }, "res");
  });
  // trust boundary: 网关可能暴露到公网，未配 key 时不做校验只可能是本机调试
  // /console 自己按 Host 限制内网访问，浏览器打不开带 key 的请求，所以单独放行。
  const open = req.url === "/healthz" || req.url.startsWith("/console");
  if (cfg.apiKey && !open) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
    if (token !== cfg.apiKey) {
      reply.code(401).send({ error: { message: "unauthorized", type: "auth_error" } });
      return;
    }
  }
  done();
});

await registerOpenAI(app);
await registerAnthropic(app);
await registerConsole(app);

app.get("/healthz", async () => {
  try {
    const a = await getAuth();
    return { ok: true, tokenTail: a.token.slice(-6), expiredAt: a.expiredAt ?? null, upstream: cfg.upstream };
  } catch (e) {
    // 凭据不可读不该让守护进程反复重启；端口活着就报 degraded。
    return { ok: false, error: String((e as Error).message), upstream: cfg.upstream };
  }
});

// 启动前探测登录态，但失败只告警不退出：keepalive 以端口存活为准，
// 进程一崩就进入「拉起→崩→拉起」循环，反而掩盖了真正的凭据问题。
try {
  await getAuth();
} catch (e) {
  app.log.warn(`auth not available at boot: ${(e as Error).message}`);
}
await app.listen({ host: cfg.host, port: cfg.port });
app.log.info(`trae-solo-gateway on http://${cfg.host}:${cfg.port} (upstream ${cfg.upstream})`);
// 后台同步模型清单；失败只降级回静态白名单，同步不在请求路径上。
startModelSync(app.log);
