#!/usr/bin/env python3
"""Probe Trae upstream with a real token (read from an auth file, never printed).

usage: probe.py <path> [bodyfile]   e.g. probe.py /api/agent/v3/create_agent_task body.json
"""
import json, subprocess, sys, time, uuid, urllib.request, urllib.error, os

# 系统代理（9090 MITM）会劫持 urllib 并因自签 CA 失败；探针必须直连。
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

AUTH_SSH = ["cat", "./secrets/trae-auth.json"]
HOST = "https://api5-normal.mchost.guru"
APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8"
VERSION_CODE = "20260924"
DEVICE_ID = "2731658870026558"
MACHINE_ID = "4a005e615aa397934f885d77179f87cbdd3428be873f574a05c0d75a4a8a17d4"


def auth():
    return json.loads(subprocess.check_output(AUTH_SSH))


def build_headers(a, path):
    tr = uuid.uuid4().hex
    return {
        "content-type": "application/json",
        "request-traffic-type": "prod",
        "user-agent": "TraeClient/TTNet",
        "x-agent-host-type": "0",
        "x-app-id": APP_ID,
        "x-app-version": "default",
        "x-app-version-code": VERSION_CODE,
        "x-bridge-transport": "aha",
        "x-custom-trace-id": tr,
        "x-device-brand": "MacBookPro18,3",
        "x-device-cpu": "Apple",
        "x-device-id": a.get("deviceId") or DEVICE_ID,
        "x-device-type": "mac",
        "x-flow-traceparent": f"04-{tr}-{uuid.uuid4().hex[:16]}-01",
        "x-ide-token": a["token"],
        "x-ide-version": "3.4.4",
        "x-ide-version-code": VERSION_CODE,
        "x-ide-version-type": "stable",
        "x-lgw-req-sdk-type": "3",
        "x-machine-id": a.get("machineId") or MACHINE_ID,
        "x-os-version": "macOS 27.0.1",
        "package-type": "stable_cn",
        "x-request-id": f"req_{uuid.uuid4()}",
        "x-lscbd-aid": "787976",
        "x-lscbd-platform": "mac",
        "X-SS-DP": "787976",
        "Referer": f"https://trae-api-cn.mchost.guru{path}",
        "accept": "*/*",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
    }


def main():
    path = sys.argv[1]
    body = b""
    if len(sys.argv) > 2:
        body = open(sys.argv[2], "rb").read()
    a = auth()
    hdrs = build_headers(a, path)
    req = urllib.request.Request(HOST + path, data=body or None, headers=hdrs,
                                 method="POST" if body else "GET")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read(4000)
            print("HTTP", r.status, f"{time.time()-t0:.1f}s", "len", len(raw))
            print(raw[:1500].decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raw = e.read(4000)
        print("HTTP", e.code, f"{time.time()-t0:.1f}s")
        print(raw[:1500].decode("utf-8", "replace"))
    except Exception as e:
        print("ERR", type(e).__name__, e)


if __name__ == "__main__":
    main()
