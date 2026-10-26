#!/usr/bin/env python3
"""Send a create_agent_task body (JSON file or inline) and stream the SSE reply.

usage: try_body.py body.json [seconds]
"""
import json, sys, time
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe import auth, build_headers, HOST
import urllib.request, urllib.error

PATH = "/api/agent/v3/create_agent_task"


def main():
    body = json.load(open(sys.argv[1]))
    limit = float(sys.argv[2]) if len(sys.argv) > 2 else 40
    h = build_headers(auth(), PATH)
    req = urllib.request.Request(HOST + PATH, data=json.dumps(body).encode(), headers=h, method="POST")
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=limit)
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read(3000).decode("utf-8", "replace"))
        return
    print("HTTP", r.status, "ctype", r.headers.get("content-type"))
    buf = b""
    while time.time() - t0 < limit:
        chunk = r.read(4096)
        if not chunk:
            print("\n[EOF]", f"{time.time()-t0:.1f}s")
            break
        buf += chunk
        while b"\n\n" in buf:
            ev, buf = buf.split(b"\n\n", 1)
            s = ev.decode("utf-8", "replace")
            if len(s) > 700:
                s = s[:700] + " …"
            print(f"{time.time()-t0:6.1f}s | {s}")
    print("total bytes", len(buf))


main()
