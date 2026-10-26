#!/usr/bin/env python3
"""Enumerate CreateAgentTaskRequest's Go fields via type-mismatch oracle.

Go ignores unknown JSON fields but names known ones on a type mismatch, so
sending every candidate at once with a value that cannot fit reveals one real
field per request. Fresh session ids per request (the server otherwise starts
demanding missing history and stops validating).
"""
import json, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_fresh import baseline, call

EXCLUDE = {"conversation_id", "session_id", "user_id", "device_id",
           "agent_type", "model_name", "config_name", "ide_version", "user_input"}


def candidates():
    raw = open("/tmp/ai_strings.txt", errors="replace").read()
    names = {m.group(0) for m in re.finditer(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", raw)}
    names = {n for n in names if 4 <= len(n) <= 40}
    names |= {"summary_config", "summary_template", "prompt_set", "extra_config",
              "model_extra_config", "common_params", "agent_context", "biz_context",
              "mode_type", "function", "history", "messages", "tools",
              "max_turn", "max_tokens", "prompt_max_tokens", "system_prompt"}
    return sorted(names - EXCLUDE)


def main():
    cands = candidates()
    print("candidates:", len(cands))
    found = {}
    for shape in ["{}", '"x"', "[]", "1", "true"]:
        val = json.loads(shape)
        remaining = [c for c in cands if c not in found]
        for _ in range(120):
            if not remaining:
                break
            body = baseline()
            for c in remaining:
                body[c] = val
            st, txt = call(body)
            m = re.search(r"cannot unmarshal \w+ into Go struct field (?:CreateAgentTaskRequest|ideagent\.\w+)\.([A-Za-z0-9_.]+) of type ([\w.\[\]]+)", txt)
            if not m:
                break
            top, typ = m.group(1).split(".")[0], m.group(2)
            found[top] = typ
            print(f"  {top}: {typ}")
            remaining = [c for c in remaining if c != top]
    print("\n=== %d fields ===" % len(found))
    for k in sorted(found):
        print(f"{k}: {found[k]}")
    json.dump(found, open("/tmp/agent_task_fields.json", "w"), indent=1)


main()
