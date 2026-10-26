#!/usr/bin/env python3
"""reasoning_effort A/B: does the upstream field actually change thinking depth?

Same prompt, temperature 0, N samples per level, compare reasoning char counts
(median) + permutation test. Single-run comparisons are meaningless here — the
same level swings 1.2k..5.6k chars run to run.

usage: effort_ab.py [model] [n_per_level]
"""
import json, itertools, random, statistics, sys, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe import auth, build_headers, HOST
import urllib.request, urllib.error

urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

MODEL = sys.argv[1] if len(sys.argv) > 1 else "deepseek-v4.1-flash"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 6
LEVELS = ["light", "high", "extra_high"]
PROMPT = "有 9 个球，其中 1 个比其他略轻。用一架天平，最少称几次能保证找出来？给出完整方案。"


def run(level):
    body = {
        "function": "chat_v3", "config_name": MODEL, "model": MODEL, "stream": True,
        "temperature": 0, "reasoning_effort": level,
        "messages": [{"role": "user", "content": [{"text": PROMPT}]}],
    }
    h = build_headers(auth(), "/api/agent/v3/llm_utils_chat")
    req = urllib.request.Request(HOST + "/api/agent/v3/llm_utils_chat",
                                 data=json.dumps(body).encode(), headers=h, method="POST")
    t0 = time.time()
    think = 0
    text = ""
    usage = {}
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        return None, e.read(400).decode(), 0, 0
    buf = ""
    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buf += chunk.decode("utf-8", "replace")
        while "\n\n" in buf:
            ev, buf = buf.split("\n\n", 1)
            name = next((l[6:].strip() for l in ev.split("\n") if l.startswith("event:")), "")
            data = next((l[5:].strip() for l in ev.split("\n") if l.startswith("data:")), "")
            if name == "output" and data:
                p = json.loads(data)
                think += len(p.get("reasoning_content") or "")
                text += p.get("response") or ""
            elif name == "token_usage" and data:
                usage = json.loads(data)
            elif name == "error" and data:
                return None, data[:300], 0, 0
    return think, text, time.time() - t0, usage.get("reasoning_tokens")


def perm_p(a, b, iters=2000):
    obs = abs(statistics.median(a) - statistics.median(b))
    pool = a + b
    hits = 0
    rnd = random.Random(7)
    for _ in range(iters):
        rnd.shuffle(pool)
        if abs(statistics.median(pool[:len(a)]) - statistics.median(pool[len(a):])) >= obs:
            hits += 1
    return hits / iters


res = {lv: [] for lv in LEVELS}
times = {lv: [] for lv in LEVELS}
for lv in LEVELS:
    for i in range(N):
        think, text, wall, rt = run(lv)
        if think is None:
            print(f"{lv} sample{i}: ERROR {text}")
            continue
        res[lv].append(think)
        times[lv].append(wall)
        print(f"{lv} sample{i}: think={think}ch wall={wall:.1f}s reasoning_tokens={rt} answer={len(text)}ch", flush=True)

print("\n=== summary ===")
for lv in LEVELS:
    if res[lv]:
        print(f"{lv:10s} n={len(res[lv])} median={statistics.median(res[lv]):.0f}ch "
              f"range={min(res[lv])}..{max(res[lv])} wall_med={statistics.median(times[lv]):.1f}s")
for a, b in itertools.combinations(LEVELS, 2):
    if len(res[a]) >= 3 and len(res[b]) >= 3:
        print(f"p({a} vs {b}) = {perm_p(res[a], res[b]):.3f}")
