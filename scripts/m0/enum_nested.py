#!/usr/bin/env python3
"""Enumerate the fields of a NESTED struct in create_agent_task's body.

usage: enum_nested.py <parent-path> [struct-hint]
  e.g. enum_nested.py extra_config CreateAgentTaskExtraConfig

Same type-mismatch oracle, but candidates go under the parent object.
"""
import json, re, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_fresh import baseline, call

EXCLUDE = {"conversation_id", "session_id", "user_id", "device_id",
           "agent_type", "model_name", "config_name", "ide_version", "user_input"}

ERR = re.compile(r"cannot unmarshal \w+ into Go struct field ([\w.]+)\.([A-Za-z0-9_]+) of type ([\w.\[\]]+)")


def candidates(hint):
    raw = open("/tmp/ai_strings.txt", errors="replace").read()
    names = {m.group(0) for m in re.finditer(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", raw)}
    names = {n for n in names if 4 <= len(n) <= 40}
    names |= {"summary_config", "summary_template", "summary_template_data", "summary_prompt",
              "prompt_set", "prompt_template", "template_id", "template_data", "agent_version",
              "summary_model_config", "enable_summary", "max_turn", "max_tokens",
              "prompt_max_tokens", "model_extra_config", "config_name", "model_name"}
    return sorted(n for n in names if n not in EXCLUDE)


def main():
    parent = sys.argv[1]
    hint = sys.argv[2] if len(sys.argv) > 2 else None
    cands = candidates(hint)
    print("parent:", parent, "| candidates:", len(cands))
    found = {}
    for shape in ["{}", '"x"', "[]", "1", "true"]:
        val = json.loads(shape)
        remaining = [c for c in cands if c not in found]
        for _ in range(150):
            if not remaining:
                break
            body = baseline()
            body[parent] = {c: val for c in remaining}
            st, txt = call(body)
            m = ERR.search(txt)
            if not m:
                break
            struct, field, typ = m.groups()
            if hint and hint not in struct:
                print("  (stopped: mismatch in", struct + "." + field, typ, ")")
                print("  ", txt[:200].replace("\n", " "))
                remaining = []
                break
            found[field] = typ
            print(f"  {field}: {typ}   [{struct}]")
            remaining = [c for c in remaining if c != field]
    print("\n=== %s: %d fields ===" % (parent, len(found)))
    for k in sorted(found):
        print(f"{parent}.{k}: {found[k]}")
    json.dump(found, open(f"/tmp/agent_task_{parent}_fields.json", "w"), indent=1)


main()
