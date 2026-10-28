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

/** 剩余积分：桌面端 credit-chips 插件的 /credits 打这里。旧 trae-proxy 有这条路由，
 *  换成 trae-solo-gateway 时漏了 → 插件拿到 404，chip 显示「—」。
 *  上游 user_current_entitlement_list 只要 token，POST 空 body 即可。 */
app.get("/credits", async (_req, reply) => {
  try {
    const a = await getAuth();
    const r = await fetch(`${cfg.authHost}/trae/api/v2/pay/user_current_entitlement_list`, {
      method: "POST",
      headers: {
        Authorization: `Cloud-IDE-JWT ${a.token}`,
        "X-Cloudide-Token": a.token,
        "x-app-id": cfg.appId,
        "x-app-version": "default",
        "x-ide-version-code": "20250002",
        "x-app-version-code": "20250002",
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    const d = (await r.json()) as { usage_summary?: { total_amount: number; consumed_amount: number } };
    const u = d.usage_summary;
    if (!u) {
      return reply.code(502).send({ error: `上游无 usage_summary: ${JSON.stringify(d).slice(0, 120)}` });
    }
    return {
      remain: +(Number(u.total_amount) - Number(u.consumed_amount)).toFixed(2),
      total: Number(u.total_amount),
      used: Number(u.consumed_amount),
    };
  } catch (e) {
    return reply.code(502).send({ error: String((e as Error).message).slice(0, 160) });
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
