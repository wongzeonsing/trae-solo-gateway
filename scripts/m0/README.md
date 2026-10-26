# M0 取证工具（只读探针）

这些是把 `create_agent_task` 的字段表"问"出来的脚本，保留下来供后续续挖。

- `probe.py` — 鉴权 + IDE 请求头 + 单次上游调用（token 从 auth 文件读取，不落盘不打印）
- `probe_fresh.py` — **每次换新 session** 的探测（不换会撞 `4000105 missing history count exceeded`）
- `walk_schema.py` — 按 `expr_path=` 逐层补字段
- `enum_fields2.py` / `enum_nested.py` — Go 类型不匹配 oracle，枚举 struct 字段（依赖 `strings libai_agent.dylib > /tmp/ai_strings.txt`）
- `try_body.py` — 打一条完整 body 并流式打印 SSE
- `brute_deflate.py` / `inflate_alauda.py` — 解 Trae 的 `.alaudalog`（raw deflate 分页）

前提：`ssh your-host` 可读 `./secrets/trae-auth.json`。
首次运行先 `strings -n 4 "/Applications/Trae CN.app/Contents/Resources/app/modules/ai-agent/libai_agent.dylib" > /tmp/ai_strings.txt`。
