import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cfg } from "../config.ts";
import { getAuth } from "../trae/auth.ts";
import { currentModels } from "../trae/models.ts";
import { snapshot } from "../console/stats.ts";

/**
 * 控制台只对内网/本机开放。
 * 不能用来源 IP 判断：请求经反代转发时来源永远是 ::1，那样等于对公网全开。
 * 所以看 Host 头——内网直连的 Host 是私网 IP，公网访问的 Host 是域名。
 */
function allowed(req: FastifyRequest): boolean {
  if (process.env.CONSOLE_ALLOW_PUBLIC === "1") return true;
  const host = String(req.headers.host ?? "")
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

const deny = (reply: FastifyReply) =>
  reply.code(403).send({ error: { message: "console is local-only; set CONSOLE_ALLOW_PUBLIC=1 to override", type: "forbidden" } });

export async function registerConsole(app: FastifyInstance) {
  app.get("/console/api/state", async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    let token: Record<string, unknown> = { ok: false };
    try {
      const a = await getAuth();
      token = {
        ok: true,
        tail: a.token.slice(-6),
        expiredAt: a.expiredAt ?? null,
        refreshExpiredAt: (a as unknown as Record<string, unknown>).refreshExpiredAt ?? null,
      };
    } catch (e) {
      token = { ok: false, error: String((e as Error).message) };
    }
    return {
      upstream: cfg.upstream,
      function: cfg.functionName,
      defaultModel: cfg.defaultModel,
      gatewayKeySet: Boolean(cfg.apiKey),
      timeouts: { totalMs: cfg.timeoutMs, headerMs: cfg.headerTimeoutMs, idleMs: cfg.idleTimeoutMs, retries: cfg.retryAttempts },
      models: currentModels(),
      token,
      ...snapshot(),
    };
  });

  app.get("/console", async (req, reply) => {
    if (!allowed(req)) return deny(reply);
    return reply.type("text/html; charset=utf-8").send(PAGE);
  });
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>trae-solo-gateway</title>
<style>
 body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
 h1{font-size:16px;font-weight:600;margin:0 0 16px}
 .row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}
 .card{background:#171a21;border:1px solid #262b36;border-radius:8px;padding:12px 14px;min-width:150px}
 .k{color:#8b93a7;font-size:12px}.v{font-size:18px;font-weight:600;margin-top:4px}
 table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
 th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #222732}
 th{color:#8b93a7;font-weight:500}
 .dim{color:#8b93a7}.bad{color:#ff6b6b}.ok{color:#4ade80}
 code{background:#1e222b;padding:1px 5px;border-radius:4px;font-size:12px}
</style></head><body>
<h1>trae-solo-gateway <span class="dim" id="ver"></span></h1>
<div class="row" id="cards"></div>
<h1>按模型用量</h1><table id="models"></table>
<h1>最近请求</h1><table id="recent"></table>
<script>
// 所有插入 DOM 的值都过 esc()：请求头（UA/路径）是用户可控的，模型名来自上游。
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = n => (n ?? 0).toLocaleString();
async function tick(){
  let d;
  try { d = await (await fetch('/console/api/state')).json(); } catch(e){ return; }
  const u = d.usage || {};
  const t = d.token || {};
  document.getElementById('cards').innerHTML = [
    ['运行时长', Math.floor(d.uptimeSec/3600)+'h '+Math.floor(d.uptimeSec%3600/60)+'m'],
    ['请求 / 错误', num(d.total)+' / '+(d.errors?(('<span class="bad">'+d.errors+'</span>')):'0')],
    ['Token 输入', num(u.prompt)],
    ['Token 输出', num(u.completion)],
    ['思考 Token', num(u.reasoning)],
    ['RSS', d.rssMb+' MB'],
    ['Token 到期', t.ok ? esc(t.expiredAt||'-') : '<span class="bad">不可读</span>'],
    ['模型数', (d.models||[]).length],
  ].map(([k,v]) => '<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');

  const bm = d.byModel || {};
  const rows = Object.entries(bm).sort((a,b)=>b[1].calls-a[1].calls);
  document.getElementById('models').innerHTML =
    '<tr><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>思考</th></tr>' +
    (rows.length ? rows.map(([m,v]) => '<tr><td><code>'+esc(m)+'</code></td><td>'+num(v.calls)+'</td><td>'+num(v.prompt)+'</td><td>'+num(v.completion)+'</td><td>'+num(v.reasoning)+'</td></tr>').join('')
                 : '<tr><td colspan="5" class="dim">本进程还没有调用</td></tr>');

  const rc = d.recent || [];
  document.getElementById('recent').innerHTML =
    '<tr><th>时间</th><th>路径</th><th>状态</th><th>耗时</th><th>UA</th></tr>' +
    (rc.length ? rc.map(r => {
      const ts = new Date(r.t).toLocaleTimeString('zh-CN',{hour12:false});
      const st = r.s>=400 ? '<span class="bad">'+r.s+'</span>' : '<span class="ok">'+(r.s??'…')+'</span>';
      return '<tr><td class="dim">'+ts+'</td><td>'+esc(r.u)+'</td><td>'+st+'</td><td class="dim">'+(r.ms??'-')+'ms</td><td class="dim">'+esc(r.ua)+'</td></tr>';
    }).join('') : '<tr><td colspan="5" class="dim">暂无</td></tr>');
  document.getElementById('ver').textContent = d.upstream + ' · ' + d.function;
}
tick(); setInterval(tick, 3000);
</script></body></html>`;
