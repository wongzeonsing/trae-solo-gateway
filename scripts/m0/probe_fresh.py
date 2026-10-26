#!/usr/bin/env python3
"""Probe create_agent_task with a FRESH session per attempt (avoids the
`missing history count exceeded` state trap).

usage: probe_fresh.py '<json-merge>'   # merged over the baseline body
"""
import json, os, sys, uuid
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe import auth, build_headers, HOST
import urllib.request, urllib.error

PATH = "/api/agent/v3/create_agent_task"
USER_ID = "318191451782010"
DEVICE_ID = "2731658870026558"


def fresh_ids():
    return uuid.uuid4().hex[:24]


def baseline():
    sid = fresh_ids()
    return {
        "conversation_id": sid,
        "session_id": sid,
        "user_id": USER_ID,
        "device_id": DEVICE_ID,
        "agent_type": "solo_agent",
        "model_name": "deepseek-v4.1-flash__max",
        "config_name": "deepseek-v4.1-flash",
        "ide_version": "3.4.4",
        "user_input": {"id": fresh_ids()},
    }


def call(body, timeout=40):
    h = build_headers(auth(), PATH)
    req = urllib.request.Request(HOST + PATH, data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(3000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(3000).decode("utf-8", "replace")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


if __name__ == "__main__":
    merge = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    b = baseline()
    b.update(merge)
    st, txt = call(b)
    print(json.dumps({k: v for k, v in b.items() if k not in ("conversation_id", "session_id")}, ensure_ascii=False))
    print(st, txt[:600].replace("\n", " | "))
