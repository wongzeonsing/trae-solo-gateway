# Trae CN 上游协议（实测）

所有结论都有对应真实响应。标记：**[已验证]** = 本仓库探针打出来的原文；**[未打通]** = 试过、结论是否定的。

上游 host：`https://api5-normal.mchost.guru`（agent 通道另有 `trae-api-cn.mchost.guru`，header `Referer` 用后者）。

---

## 1. 鉴权

**[已验证]** `x-ide-token: <JWT>` 走 header，取自 auth 文件：

```json
{ "token", "refreshToken", "expiredAt", "userId", "deviceId", "machineId",
  "privateKeyPEM", "publicKeyPEM" }
```

- 有效期实测：`expiredAt = 2026-11-05T12:46:16Z`（约 14 天）。
- **续期未实现**：新版走 ECDSA-P256 + DeviceProof，不可复刻；旧接口
  `POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`
  （ClientID `ono9krqynydwx5`、RefreshToken、ClientSecret `"-"`、UserID）是唯一可行路径，待接。

## 2. 请求头

**[已验证]** 服务端对头校验很松。必须有的只有 `content-type` + `x-ide-token`；其余照抄 IDE 更稳：

```
x-app-id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8   # AppId，进配置查询元组
x-ide-version: 3.4.4
x-ide-version-code: 20260924                      # ← 新模型的闸门，旧的会 4001
x-device-id / x-machine-id                        # 取自 auth 文件
package-type: stable_cn
```

**[已验证] 不需要**：`X-Helios`、`X-Medusa`、`x-request-pin`、`x-requested-at`。
IDE 每次请求都会带（"masticate" 加密层，在 `libharness.dylib`），但**明文 body 一样被接受**——
这推翻了"必须复刻上行加密"的假设，是整个项目的转折点。

## 3. `POST /api/agent/v3/llm_utils_chat`（本仓库使用）

**[已验证]** 一问一答非 agent 通道，明文 body：

```json
{ "function": "chat_v3", "config_name": "<model>", "model": "<model>", "stream": true,
  "messages": [ { "role": "user|assistant|system",
                  "content": [ { "type": "text", "text": "…" } ] } ] }
```

`messages[].content` 必须是**数组**，传字符串会被拒：
`cannot unmarshal string into Go struct field LLMRawMessage.messages.content of type []*idecopilot.LLMRawMessageContent`。
`content` 元素里 `type: "text"` 可省，`{"text": "…"}` 即可。

### 响应事件表（SSE，`text/event-stream`）

帧格式：`id:N\nevent:<name>\ndata:<json>\n\n`

| event | 载荷 | 用途 |
|---|---|---|
| `metadata` | `{model,session_id,prompt_completion_id,ab_versions,app_version,ide_version,…}` | 首帧，拿 session_id |
| `timing_cost` | `{name,queue_timing,platform_first_token_timing,server_processing_time,…}` | 排队/耗时诊断 |
| `output` | `{response,reasoning_content,tool_calls,multimodal_contents,phase}` | **正文与思考链增量**（都是 delta，逐帧拼接） |
| `extra_info` | `{model,content,input_token,expire_time}` | provider 侧模型名与完整思考链快照 |
| `token_usage` | `{prompt_tokens,completion_tokens,total_tokens,reasoning_tokens,…}` | 用量 |
| `done` | `{finish_reason:"stop"\|"length"}` | 结束 |
| `error` | `{code,message}` | **HTTP 可能仍是 200**，必须按失败处理 |

实测一轮：

```
event:output  data:{"response":"","reasoning_content":"我们需要"…}   ×14
event:output  data:{"response":"收到啦","reasoning_content":null}
event:token_usage data:{"prompt_tokens":38,"completion_tokens":56,"reasoning_tokens":53,…}
event:done    data:{"finish_reason":"stop"}
```

> `reasoning_content` 与 `response` 会**先思考后正文**交替出现；网关侧要分两条流，不能混进 `content`。

## 4. `POST /api/agent/v3/create_agent_task`（原生 SOLO agent，**[未打通]**）

这是立项书想接的通道。本次把它推进到了"只差一层"的位置，结论如下。

### 4.1 明文 body 同样被接受 **[已验证]**

```
POST create_agent_task  body={}
HTTP 400 {"code":4001,"message":"bad request: binding: expr_path=conversation_id, cause=missing required parameter"}
```

### 4.2 必填字段（错误 oracle 逐层走出来的最小集）**[已验证]**

服务端是 Go 服务（`ideagent.CreateAgentTaskRequest`），**未知字段静默忽略、已知字段类型不符会报字段名**，所以字段表是"问"出来的，不是猜的：

```json
{ "conversation_id": "<24hex>", "session_id": "<24hex>",
  "user_id": "318191451782010", "device_id": "2731658870026558",
  "agent_type": "solo_agent", "function": "solo_agent",
  "config_name": "<model>", "model_name": "<model>__max",   // 必须变体名
  "ide_version": "3.4.4",
  "user_input": { "id": "<24hex>", "messages": [ … ], "source": "…" } }
```

### 4.3 `CreateAgentTaskRequest` 完整字段表 **[已验证]**

| 字段 | 类型 | 字段 | 类型 |
|---|---|---|---|
| conversation_id / session_id / user_id / device_id | string | history_id_list | []string |
| agent_type / model_name / config_name / ide_version | string | parent_session_id | string |
| function / agent_id / message_origin / message_source | string | session_type | string |
| authorized_services / custom_model_type | string | access_type | idecopilot.AccessType |
| reasoning_effort | string | mode_type | commercialization.ModeType（数值） |
| is_custom_model / skill_list_changed / use_fast_request | bool | skill_list | []ideagent.Skill |
| user_input | ideagent.UserInput | extra_config | ideagent.CreateAgentTaskExtraConfig |
| biz_context | common.BizContext | custom_subagent_info | map[string][]string |
| agent_run_info | ideagent.AgentRunInfo | agent_dsl | ideagent.AgentDSLDefinition |

嵌套结构（同样是 oracle 探出来的）：

```
user_input   = { id: string, messages: []ideagent.StandardChatMessagePart, source: string }
                 StandardChatMessagePart = { type: string, image_id: string }
extra_config = { enable_chat_memory_user_config: bool, enable_core_memory: bool }
biz_context  = { window_type: string }              // 只有这一个
agent_run_info = { agent_call_id, agent_run_id, parent_agent_run_id,
                   subagent_type, task_id: string, is_async: bool }
```

> 注意：**`agent_context` 不是这个请求的字段**。IDE 侧那个 52 字段的 `AgentContext`
> 被拆进了 `biz_context` / `skill_list` / `messages`。**system prompt 由服务端按
> `config_name` + `function` 自己拼** —— 网关不需要自己拼 152KB prompt。

### 4.4 卡点：`failed to get summary config` **[未打通]**

```
HTTP 200  event:error
{"code":4001,"message":"failed to get summary config: failed to get summary template data"}
```

已系统排除的轴（每组都是 fresh session 实测）：

| 轴 | 结果 |
|---|---|
| `mode_type` 0/1/2/3/4/8/16 | 全通过，错误不变 → 不是开关 |
| `agent_type` × `mode_type` 7×4 矩阵 | 只有 summary / model config / config item 三种错误 |
| `extra_config`（2 个 bool） | 无变化 |
| `biz_context.window_type` | 无变化 |
| `skill_list`（builtin 4 个真实技能名） | 无变化 |
| header：`x-plugin-channel` / `x-os-type` / `agent-version` 等 6 组 | 无变化 |
| 先打 `query_history_state` 再 create | 返回 `{"missing":[sid]}`，错误不变 |
| `messages` 三种 content 形态 | 逐字相同 |

**关键旁证**：用 `function=solo_coder` 能**回显服务端解析后的配置查询元组**（内省 oracle）：

```
{AppId, Function, ConfigName, VersionCode, PluginChannel:null, IdeVersion:"3.4.4",
 ModeType:0, AgentType:"solo_coder", AgentVersion:null, ClientIp, OSType:"",
 IsCustomModel:false, Account{…}, Provider:"", AbForceVids:null}
```

`AgentVersion: null` / `PluginChannel: null` / `OSType: ""` 都补不上——它们既不来自
body 的任何已知字段，也不来自 header。summary 模板由服务端按一个我们无法设置的维度解析。

**判定**：原生 agent 通道在当前账号/版本上不可达，与立项书 §2.5 的预判一致。
M0 到此为止，转兜底路线。若日后继续，唯一有意义的下一步是拿到 IDE 那次成功请求的
**完整明文 body**（需在 `libharness` 的 masticate 之前 hook），逐字段 diff。

### 4.5 会话状态陷阱 **[已验证]**

同一 `session_id` 上第二次 `create_agent_task` 会变成：

```
{"code":4000105,"error":"","message":"missing history count exceeded for session <id>"}
```

服务端按 session 记账并索要缺失历史。**探针必须每次换新 session**，否则后面的请求不再做
字段校验，会把你引向错误结论（本项目踩过一次）。

## 5. 其它端点（从 `libai_agent.dylib` 提取，未逐个验证）

```
/api/agent/v3/{create_agent_task, commit_toolcall_result, interrupt, resume_agent_task,
               get_resume_agent_task_status, query_history_state, sync_history_state,
               compact, llm_utils_chat, workflow/start, workflow/commit_toolcall,
               use_fast_request, generate_summary, dsl/logs/subscribe, dsl/templates,
               dsl/render/resources}
/api/ide/v1/{chat, get_detail_param, batch_get_detail_param, model_list, agents/runs, …}
```

- `query_history_state` 请求 `{"history_id_list":[sid]}`，响应 `{"missing":[sid],"code":null,"message":null}`。
- `batch_get_detail_param`：模型目录，明文，2.6MB，`function_configs[]→config_info_list[]→model_detail_list[]`。
  `model_name` 形如 `<config_name>__dev` / `__max`，每个变体自带 `model_extra_config`（约 5KB，含 compaction 策略、180 个开关）。
- `workflow/start`：`summarize_message` 工作流，`task_created` 里带 `workflow_info{workflow_name,workflow_id,node_name}`。
  运行时日志有 `synthetic finish summary prepared, summary_from_completion=true` —— 摘要由 completion 本地合成。

## 6. 错误码

| code | 出现位置 | 含义 |
|---|---|---|
| 4001 | HTTP 400 | JSON/binding 错误，`expr_path=` 指名缺哪层 |
| 4001 | SSE error（HTTP 200） | 配置/模型/summary 层拒绝，`message` 逐层不同 |
| 3003 | SSE error | `all models failed`（`/api/ide/v1/chat`） |
| 4000105 | SSE error | 会话历史缺失，`missing history count exceeded` |
| 401/403 | HTTP | token 过期或无效 |

`config item is empty for config opt: {...}` 会**回显完整元组**，是排查配置维度最快的入口。
