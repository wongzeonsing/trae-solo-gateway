/** 进程内统计：重启清零，不落盘。够回答「今天用了多少、哪个模型用得多、最近错在哪」。 */

export type ReqRec = { t: number; u: string; ua: string; via: string; s?: number; ms?: number };

type ModelUsage = { calls: number; prompt: number; completion: number; reasoning: number };

const MAX_RECENT = 80;

const state = {
  started: Date.now(),
  total: 0,
  errors: 0,
  byStatus: {} as Record<string, number>,
  byUa: {} as Record<string, number>,
  usage: { prompt: 0, completion: 0, reasoning: 0, calls: 0 },
  byModel: {} as Record<string, ModelUsage>,
  recent: [] as ReqRec[],
};

export function beginRequest(u: string, ua: string, via: string): ReqRec {
  const rec: ReqRec = { t: Date.now(), u, ua, via };
  state.total++;
  state.recent.unshift(rec);
  if (state.recent.length > MAX_RECENT) state.recent.pop();
  return rec;
}

export function endRequest(rec: ReqRec, status: number, ms: number) {
  rec.s = status;
  rec.ms = ms;
  state.byStatus[status] = (state.byStatus[status] ?? 0) + 1;
  if (status >= 400) state.errors++;
  if (rec.ua) state.byUa[rec.ua] = (state.byUa[rec.ua] ?? 0) + 1;
}

export function addUsage(model: string, u: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }) {
  const p = u.prompt_tokens ?? 0;
  const c = u.completion_tokens ?? 0;
  const r = u.reasoning_tokens ?? 0;
  state.usage.calls++;
  state.usage.prompt += p;
  state.usage.completion += c;
  state.usage.reasoning += r;
  const m = (state.byModel[model] ??= { calls: 0, prompt: 0, completion: 0, reasoning: 0 });
  m.calls++;
  m.prompt += p;
  m.completion += c;
  m.reasoning += r;
}

export function snapshot() {
  const mem = process.memoryUsage();
  return {
    started: state.started,
    uptimeSec: Math.round((Date.now() - state.started) / 1000),
    pid: process.pid,
    rssMb: Math.round(mem.rss / 1048576),
    total: state.total,
    errors: state.errors,
    byStatus: state.byStatus,
    byUa: Object.fromEntries(Object.entries(state.byUa).sort((a, b) => b[1] - a[1]).slice(0, 5)),
    usage: state.usage,
    byModel: state.byModel,
    recent: state.recent.slice(0, 40),
  };
}
