# trae-solo-gateway

> **免责声明**
>
> 本项目通过分析 Trae CN 桌面客户端的通信协议实现，与字节跳动 / Trae 官方**没有任何关系**，也未获其授权。
> 仅供个人学习与协议研究使用。使用它很可能违反 Trae 的服务条款，可能导致账号被限制或封禁；请自行承担全部风险，
> 不要用于商业用途、对外提供服务或大规模分发。运行需要你自己账号的登录态，本仓库不包含、也不分发任何凭据。
>
> 本项目按「现状」提供，不承诺可用性、稳定性或兼容性；上游随时可能变更或失效。
> 如果你只是想稳定地用模型，请购买官方服务。

把 Trae CN 的模型封装成 OpenAI / Anthropic 兼容 API。独立进程、独立仓库、默认端口 `19900`。

**现状**：`chat_v3`（`llm_utils_chat`）通道已打通并验收，支持原生 function calling；原生 SOLO agent 通道
（`create_agent_task`）被服务端 summary 配置卡住，详见 `docs/PROTOCOL.md` §4。

## 前置条件

- Node >= 22（直接跑 TypeScript，无需构建）
- 一个可用的 Trae CN 账号
- **一次性**导出登录态：在装有 Trae CN 的机器上登录后，取出
  `token / refreshToken / deviceId / machineId / privateKeyPEM`，写成 auth JSON
  （`TRAE_AUTH_FILE` 指向它，权限建议 600）

导出之后**不需要**保持 Trae 运行。续期走独立的 OAuth 接口，不依赖 IDE 进程，也不需要设备证明：
token 寿命 14 天，网关在剩余 <30 分钟时自动换新并原子写回。refreshToken 本身到
`refreshExpiredAt` 才失效（通常还有几个月），到期后才需要再导一次。

即使 token 已过期，只要 refreshToken 还有效，网关会在第一次请求前自己续上。

## 跑起来

```bash
npm install
cp .env.example .env          # 按需改
TRAE_AUTH_FILE=/path/to/trae-auth.json node src/main.ts
```

`TRAE_AUTH_FILE` 指向 Trae 登录态 JSON（`{token, refreshToken, deviceId, machineId, …}`）。
**不要提交进仓库，也不要写进日志。**

## 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容，`stream:true` 走 SSE；思考链放在 `delta.reasoning_content` |
| `POST /v1/messages` | Anthropic 兼容，SSE；思考链走 `thinking_delta` |
| `GET /v1/models` | 上游同步的可见模型（裸名；**不列 `__max` 变体**，变体靠 `<名>:max` 手写调用。失败时回退 `src/config.ts` 的 `MODELS`） |
| `GET /healthz` | 登录态可读性 + 过期时间 |

```bash
# 流式
curl -N http://127.0.0.1:19900/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"只回答两个字：通了"}]}'

# 探针（直接打上游，不经 HTTP 层）
npm run probe
npm run probe -- glm-5.3-flash "回答两个字：你好"
```

## 部署

默认只监听回环 —— 网关只接受本机请求，不暴露到局域网或公网。放到任意一台能跑 Node 的机器上，
Node >=22 + `--env-file=.env`：

```
.env                   HOST=127.0.0.1 / PORT=19900 / TRAE_AUTH_FILE=./secrets/trae-auth.json / GATEWAY_KEY=***
scripts/keepalive.sh   端口在 listen = 活着；不在就拉起
crontab                @reboot + 每分钟 keepalive.sh
```
平台差异只有守护脚本这一处：

| | 守护 |
|---|---|
| Linux | `scripts/keepalive.sh`（`ss` 探端口）+ `crontab`: `@reboot` 与每分钟 |
| macOS | 同一份脚本（自动改用 `lsof`），`crontab` 或 `launchd` 都行 |
| Windows | 没有 bash —— 直接 `node --env-file=.env src/main.ts`，常驻交给任务计划程序 / NSSM |

服务本身是纯 Node（fastify + fetch），没有平台相关代码，三个系统跑的是同一份 `src/`。


- 服务地址：`http://127.0.0.1:19900/v1`
- `GATEWAY_KEY` 非空时 `/v1/*` 必须带 `Authorization: Bearer <key>`；`/healthz` 放行给守护脚本。

需要从别的机器访问时，把 `HOST` 改成 `0.0.0.0`（或某个具体网卡地址），并**务必**先打开 `GATEWAY_KEY`；
更推荐的做法是保持回环、在前面套一层反向代理（TLS + 鉴权）。

客户端接入（OpenAI 兼容）：

```yaml
providers:
  trae:
    base_url: http://127.0.0.1:19900/v1
    api_key: <GATEWAY_KEY>
    model: deepseek-v4.1-flash
```

> 反向代理后面接时，`base_url` 换成代理的地址，其余不变。

## 鉴权与续期

- **登录态**：`TRAE_AUTH_FILE` 只读；`token` 是 Trae IDE 的那个 JWT（14 天）。
- **自动续签**：剩余 <30 分钟（`TRAE_REFRESH_SKEW_MS` 可调）时调
  `POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken`
  （`{ClientID, RefreshToken, ClientSecret:"-", UserID:""}`），响应在 `Result` 里，
  取 `Token / RefreshToken / TokenExpireAt / RefreshExpireAt`。
  **每次调用都会轮换 RefreshToken**，所以必须原子写回 auth 文件（保留
  `deviceId/machineId/privateKeyPEM` 等原字段）；写回失败只降级为内存内使用。
- **并发安全**：续期用 in-flight 去重，多个请求同时到达时只刷一次。

## 模型档位：思考与 Max

Trae 的模型有两套档位，但**在 `llm_utils_chat` 通道上只有 Max 可用**。下面的数字都是实测，不是抄文档。

### 思考档：请求参数是空操作，只能靠选模型

上游的 `LLMUtilsChatRequest`（Go 结构，用「字段塞错类型看 decoder 报不报错」的方式验过）只有 15 个字段：

```
function  config_name  model_name  provider  messages  tools  tool_choice
queue_id  request_seq  custom_model_uniq_id
user_input  session_id  message  conversation_id  is_custom_model
```

**`reasoning_effort` 不在里面**——对象 / 数组 / 数字 / 布尔四种类型都试过，全部被静默忽略。写进 body 是空操作，上游永远取模型配置里的 `default_level`。

想改变思考量只能换模型：

| 默认档 | 模型 |
|---|---|
| `extra_high`（最深） | `kimi-k3` / `kimi-k3.1-pro` / `kimi-k2.8-preview` / `minimax-m3.1-flash` |
| `high`（多数模型） | `deepseek-v4.1-flash` / `glm-5.3*` / `glm-5.2` / `DeepSeek-V4-*` / `qwen3.8-*` / `Doubao-Seed-*` / `step-5-preview` |
| 不思考（`support_thinking:false`，零 reasoning token） | `Doubao-Seed-Evolving` / `mimo-v2.6-flash` / `mimo-v2.6-pro` / `minimax-m3` / `qwen-3.7-plus` |

权威来源是 `POST /api/ide/v1/batch_get_detail_param {"functions":["chat_v3"]}` 响应里 `config_info_list[].reasoning_effort_config`，档位随上游变，别写死。

### Max：用 `model_name` 选变体

同一个模型有两套配置档，靠 `model_name` 切换，`config_name` 放裸名：

| body | 结果 |
|---|---|
| `config_name: <名>` | 200，上游默认 `__dev` |
| `+ model_name: <名>` | **4001 the model is unknown**（裸名不能当变体名） |
| `+ model_name: <名>__dev` | 200 |
| `+ model_name: <名>__max` | 200，1M 档生效 |

客户端写法 `<名>:max` / `<名>@max` 也认（`src/trae/chat.ts` 的 `splitModel()`）。

`deepseek-v4.1-flash`（chat_v3）两档的真实差异：

| | `__dev` | `__max` |
|---|---|---|
| 上下文参考值 | 116,000 | 1,000,000 |
| prompt 预算 | 100,000 | 936,000 |
| **单轮输出上限** | **16,000** | **64,000** |

`/v1/models` 只列裸名，不再追加 `__max` 变体（列表瘦身，35→19）。要走 Max 档就在调用时写 `<名>:max` 或 `<名>__max`，`splitModel()` 会翻译成上游的变体名；列表里没有的名字照样能发，请求路径不校验清单。

### 两个坑

1. **上下文数字不是硬墙。** 实测 `__dev` 档一次吃 277,826 prompt tokens 全量通过（`cache_read_input_tokens=0`），116k 只是参考值，别拿它当失败阈值。
2. **输出上限是硬墙，而且截断时 `finish_reason` 报 `stop`。** 让模型写长文，`__dev` 档 `completion_tokens` 精确停在 **16,000**（输出 41,961 汉字），`finish_reason: stop`。靠 `finish_reason == length` 判截断的客户端**永远判不到**，只会拿到内容腰斩但语法完整的产出——这是这套通道最咬人的一处。

中文 token 效率约 **2.6 字符/token**（16k 输出上限 ≈ 4.2 万汉字，按 1 token≈1.5 汉字估会差 3 倍）。

日常问答、单文件改动用裸名；写大文件、长报告、大补丁才切 `__max`。

> 客户端自己的上下文规划可能比上游小：Hermes 对不认识的模型 id 一律 fallback 256k，压缩阈值取一半 = 128k，所以 1M 那档在它里面走不到，除非显式设 `model.context_length`。

## 控制台

`GET /console` 是一个进程内的状态面板：请求数与状态分布、按模型的 token 用量、最近请求、RSS、token 到期时间、实际生效的超时。

- **只对内网/本机开放**：按 `Host` 判断（转发后的来源 IP 恒为 `::1`，按 IP 判等于对公网全开），公网请求返回 403。
- 数据只在内存里，进程重启清零；不落盘、不依赖数据库。
- 确实要对外暴露时设 `CONSOLE_ALLOW_PUBLIC=1`，但请先套一层自己的鉴权。

## 超时

- 网关自身总超时 `TRAE_TIMEOUT_MS`（默认 120s，可调）。
- 非流式响应先发 `Transfer-Encoding: chunked` 头，并每 8s 写入一个换行保活，
  避免长请求被中间设备判为超时（JSON 解析容忍前导空白）。
- 流式首字节通常 <1s；长回答走流式更稳。

## 相关工作

- [ZedeX/trae-local-api](https://github.com/ZedeX/trae-local-api) —— 最早公开 `ExchangeToken`
  续期链路（该项目的许可证是「仅供学习研究」，不是 MIT，因此这里只借鉴协议事实）
- [Ttungx/trae-solo-local-api](https://github.com/Ttungx/trae-solo-local-api) —— SOLO 轻排队通道
  与「思考档位走提示词前缀注入」的做法

本项目是独立实现，未复用上述项目的代码。所有端点、字段名、错误码均来自对客户端自身流量的
观察与逐字段验证；已经试过并确认走不通的路子记在 `docs/PROTOCOL.md` §6。

## 边界

- 只从 auth 文件读鉴权，token 不进日志。
- 所有上游调用有总超时（`TRAE_TIMEOUT_MS`，默认 120s）；SSE 断流/上游 `event:error`/网络中断分别转成客户端能识别的错误。
- `LOG_LEVEL=debug` 打请求元信息；生产默认 `info`。

## 未做（有明确升级路径）

- **token 自动续期**：已实现，走旧 `ExchangeToken` 接口（剩余 <30 分钟自动刷新，原子写回并保留 `deviceId/machineId/privateKeyPEM`）。
- **模型清单**：启动时后台拉 `batch_get_detail_param`（`{"functions":["chat_v3"]}`，228KB）同步可见模型，缓存 6 小时；不追加 `__max` 变体（见「模型档位」一节）。拉取失败或为空时回退静态白名单 `MODELS`。
- **原生 agent 通道**：见 `docs/PROTOCOL.md` §4.4。
- **工具调用**：`llm_utils_chat` 原生支持 function calling——`tools[].function.parameters` 必须是 **JSON 字符串**；支持并行调用与 `assistant.tool_calls` + `role:"tool"` 的多轮回传。
