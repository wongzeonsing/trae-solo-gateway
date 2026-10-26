#!/usr/bin/env python3
"""Discover ideagent.StandardChatMessagePart's shape + test body combinations.

Two phases:
  1. type-mismatch oracle on part fields (messages=[{cand: {}} ...])
  2. matrix of plausible message/top-level combos, each on a fresh session
"""
import json, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_fresh import baseline, call

ERR = re.compile(r"cannot unmarshal \w+ into Go struct field ([\w.]+)\.([A-Za-z0-9_]+) of type ([\w.\[\]]+)")
CANDS = ["type", "text", "content", "image_url", "url", "image_id", "id", "mime_type", "name",
         "data", "parts", "role", "media_type", "source", "path", "base64", "detail", "width",
         "height", "kind", "value", "body", "payload", "message", "msg", "part", "image"]


def phase1():
    print("== phase 1: part fields ==")
    found = {}
    for shape in ["{}", '"x"', "[]", "1"]:
        val = json.loads(shape)
        remaining = [c for c in CANDS if c not in found]
        for _ in range(30):
            if not remaining:
                break
            b = baseline()
            b["user_input"]["messages"] = [{c: val for c in remaining}]
            st, txt = call(b)
            m = ERR.search(txt)
            if not m:
                break
            struct, field, typ = m.groups()
            if "StandardChatMessagePart" not in struct:
                print("   other:", struct, field, typ, "|", txt[:150].replace("\n", " "))
                break
            found[field] = typ
            print(f"   part.{field}: {typ}")
            remaining = [c for c in remaining if c != field]
    return found


def phase2(fields):
    print("\n== phase 2: combos ==")
    tag = "type" if "type" in fields else None
    textf = "text" if "text" in fields else ("content" if "content" in fields else None)
    print("   tag:", tag, "text field:", textf)
    if not textf:
        return
    part = {textf: "你好，请回复一个字"}
    if tag:
        part[tag] = "text"
    combos = {
        "msg only": {"messages": [part]},
        "msg+source": {"messages": [part], "source": "solo"},
        "msg+skill_list": {"messages": [part], "skill_list": []},
        "msg+biz+run": {"messages": [part], "biz_context": {}, "agent_run_info": {}},
        "msg+access0": {"messages": [part], "access_type": 0},
        "msg+access1": {"messages": [part], "access_type": 1},
        "msg+function": {"messages": [part], "function": "solo_agent"},
        "msg+session_type": {"messages": [part], "session_type": "solo"},
    }
    for name, patch in combos.items():
        b = baseline()
        b["user_input"].update(patch)
        st, txt = call(b)
        print(f"   {name}: {st} {txt[:220].replace(chr(10), ' | ')}")


f = phase1()
phase2(f)
