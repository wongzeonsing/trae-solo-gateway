#!/usr/bin/env python3
"""Walk create_agent_task's request schema from the live server's error oracle.

Reacts to two error shapes:
  binding: expr_path=<field>, cause=missing required parameter
  json: cannot unmarshal <src> into Go struct field <Struct>.<field> of type <T>
Adds/fixes fields, repeats, prints the trace and the final body.
"""
import json, re, sys, uuid
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe import auth, build_headers, HOST
import urllib.request, urllib.error

PATH = "/api/agent/v3/create_agent_task"

KNOWN = {
    "conversation_id": "6adc65e3f5aad1e565c28fb8",
    "session_id": "6adc65e3f5aad1e565c28fb8",
    "user_id": "318191451782010",
    "device_id": "2731658870026558",
    "agent_type": "solo_agent",
    "model_name": "deepseek-v4.1-flash",
    "config_name": "deepseek-v4.1-flash",
    "ide_version": "3.4.4",
}

SCALAR = {
    "string": "x",
    "int": 0, "int32": 0, "int64": 0, "uint": 0, "uint32": 0, "uint64": 0,
    "float": 0.0, "float32": 0.0, "float64": 0.0,
    "bool": False, "boolean": False,
}


def call(body, timeout=60):
    h = build_headers(auth(), PATH)
    req = urllib.request.Request(HOST + PATH, data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(8000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(8000).decode("utf-8", "replace")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


def set_path(body, path, value):
    cur = body
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
        if not isinstance(cur, dict):
            return
    cur[parts[-1]] = value


def get_path(body, path):
    cur = body
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return None, False
        cur = cur[p]
    return cur, True


def main():
    body = dict(KNOWN)
    for step in range(60):
        st, txt = call(body)
        one = txt.replace("\n", " ")[:300]
        print(f"[{step}] {st} | {one}")
        m = re.search(r"expr_path=([A-Za-z0-9_.]+), cause=missing required parameter", txt)
        if m:
            f = m.group(1)
            set_path(body, f, KNOWN.get(f, "x" if not f.endswith("s") else []))
            continue
        m = re.search(r"cannot unmarshal \w+ into Go struct field \w+\.([A-Za-z0-9_.]+) of type ([\w.]+)", txt)
        if m:
            f, typ = m.group(1), m.group(2)
            default = KNOWN.get(f, SCALAR.get(typ))
            if default is None:
                default = {} if "." in typ else "x"
            set_path(body, f, default)
            continue
        m = re.search(r"json: cannot unmarshal .* into Go value of type ([\w.]+)", txt)
        if m and isinstance(body, dict):
            print("   (top-level type issue:", m.group(1), ")")
        print("\n=== STOP ===")
        print(json.dumps(body, ensure_ascii=False, indent=1))
        return
    print("(limit reached)")


main()
