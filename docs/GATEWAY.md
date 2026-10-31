# GATEWAY — Rust 版 Gateway 反代设计文档

> 目标：在 zcode-switch（Tauri）内嵌 OpenAI/Anthropic 兼容反代，复用本工具现成的多号凭据体系，替代旁挂 `ZCode2api-go` 独立进程。
> 参考实现：`ZCode2api-go`（Go，~2.6k 行，协议已验证）。本文是其 Rust 翻译的设计与分解。
> 状态（2026-10-31）：M1 落地；M2 已编译，真实出话由 M3-E Python 同构复刻验收（薄头集 200 出话，见 §6.5）；M3 OpenAI 转换器已接 `/v1/chat/completions`（非流式+SSE）；多号池 `pool.rs` 已接线 server.rs（未 e2e）。注意：OpenAI 转换器存在双实现（`openai.rs` 主实现，`translate.rs` 内为早期副本待撤），server.rs 当前挂的仍是 `translate.rs` 版——收敛后以 `openai.rs` 为准。

## 0. 一页结论

上游只有**一个端点**：`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`（Anthropic messages 形态）。反代的工作 = 把 N 种客户端协议翻译成这一种，再把 SSE 回包翻译回去。鉴权、凭据、mid、身份块全部复用 zcode-switch 现有 `claim.rs`/`store.rs` 体系。

## 1. 协议矩阵

| 入站端点 | 客户端协议 | 转换器 | SSE 流式 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（经典） | chat → anthropic，回包反向 | data: chunks，含 `data: [DONE]` |
| `POST /v1/responses` | OpenAI Responses API（新） | `input`/`instructions`/`max_output_tokens` → anthropic | events 形态 |
| `POST /v1/messages` | Anthropic Messages（原生） | 直通（仅 system 前缀注入 + 参数钳制） | `event:`/`data:` 双行 |
| `GET /v1/models` | OpenAI Models | 静态列表 | — |
| `GET /health` | — | — | — |

Go 版对应物：`server.go`（路由+鉴权）、`anthropic.go`（222 行）、`responses.go`（489 行，`BuildAnthropicFromResponses`）、`translate.go`（529 行，双向转换核心）。

## 2. 架构

```
┌─ zcode-switch (Tauri) ─────────────────────────────┐
│  Webview UI ──(start/stop/status IPC)──► GatewayCtl │
│                                        │           │
│  [gateway 模块, 独立线程]                ▼           │
│   axum listener (可配端口)                        │
│    ├─ /v1/chat/completions ─┐                     │
│    ├─ /v1/responses ────────┼─► translate ───────┼──► zcode.z.ai
│    ├─ /v1/messages ─────────┘   (anthropic 形态)  │    /api/v1/zcode-plan/
│    └─ /v1/models (静态)                           │    anthropic/v1/messages
│   Bearer sk-… 鉴权；多号池：store 现成凭据          │
└────────────────────────────────────────────────────┘
```

- **进程内常驻线程**：托盘模式照常服务；窗口关闭不影响（`close_to_tray` 已有）。
- **凭据复用**：`~/.zcode-switch/accounts/*.json`（enc:v1 解密、`virtual_device_mid`）直接读，与切号共用一份真源——不引 Go 版的 `zcode_devices.json` 第二份落盘。
- **身份块**：system 前缀（seg0+seg1，来自 `prefix.json` 快照）+ `metadata.user_id` + trace 头，照抄 Go 版 `translate.go:151` 的白名单逻辑。**前缀快照需跟随 ZCode 大版本重新提取**（Go 版 `assets/prefix.json` 标注提取自 3.16.3，升 3.17.1 后未验证是否漂移——首个实测项）。

## 3. 多号池（对照 Go 版 `pool.go` + `client.go:134`）

| 上游错误 | 冷却 |
|---|---|
| 401 | 30 min（token 失效） |
| 429 | 60 s（限流/额度） |
| 405 / body 含 3012 | 10 min（风控） |
| 3008/3009/3010 | 60 s（并发上限） |
| 3007（captcha verify failed） | 60 s（已实现，upstream.rs 按 **body code** 匹配——HTTP 形态是 400+`code:3007`，不能按状态码匹配。当前靠服务端 `skip_model_request:true` 不会出现；若豁免翻 false 即确定性拒绝，60s 档防固定 JWT 无限重打。真支持则接无痕取票，见 §6.3） |
| 其他 | 0（直接返回，不换号） |

策略：失败换下一号，冷却期内跳过；全部耗尽回 503。`window_test.go` 里有窗口调度测试，Rust 版同构。

**落地状态（2026-10-31）**：`pool.rs` 已实现（`Farm`：成员列表 + 粘性游标 + 冷却表 + `global_backoff` 全局退避；`settle` 失败才挪游标），`server.rs` 发送路径已接线（`farm_members` 取号 → 发送 → `settle` 落冷却/换号，`is_global_risk` 触发全池退避）。多号切换端到端未跑真实验收。

## 4. 模块分解（Rust 侧新增）

```
src-tauri/src/gateway/
  mod.rs        — GatewayCtl：启停线程、状态共享（AtomicBool + 端口/密钥配置）
  server.rs     — axum 路由 + Bearer 鉴权 + health + /v1/chat/completions、/v1/messages 接线
  translate.rs  — anthropic 直通（M2）+ OpenAI 转换（M3 早期副本，待撤，收敛到 openai.rs）
  openai.rs     — OpenAI chat/completions ⇄ anthropic 主实现：tool_calls/视觉(data:image)/tool_result、
                  Delta 流式语义（translate_sse_line）+ 帧构造（completion_frame/chunk_frame）
  pool.rs       — 多号轮询 + 冷却 + 全局退避（读 store 凭据，已接线 server.rs）
  upstream.rs   — z.ai messages 客户端（reqwest，非流式聚合 + bytes_stream 流式；冷却表）
```

依赖新增：`axum`（或 tiny-http + 手路由）、`tokio`（Tauri 已带）、`reqwest` stream。IPC 命令：`gateway_start` / `gateway_stop` / `gateway_status`，配置落 `~/.zcode-switch/gateway.json`（端口、sk-… 密钥）。

## 4b. 前端设计（已落骨架：`views/gateway.jsx`，commit `2183856`）

控制面板复用关于页的居中卡片视觉（`.about-card.gateway-card`），自上而下四段：

1. **品牌行**：`Gateway` 大字 mono + 状态徽标（`已停止` 灰 / `运行中` mint 绿，随状态轮询变色）；菜单名 zh「网关」/ en「Gateway」（App.jsx 曾存在的双渲染块已修）
2. **端点说明块**：一句话说明 OpenAI 兼容形态与上游调用方式
3. **配置表单 ×2**：端口输入（默认 8081）、API 密钥输入（调用方鉴权），各带保存按钮——当前 disabled，接 `gateway_status` 后按「配置与运行态一致才可改」的规则启用
4. **启停按钮行**：`启动服务` / `停止服务` 互斥 disabled（运行中只亮停止），接 `gateway_start/stop`

**待接状态设计**（M1 接线时的完整面板）：

- `gateway_status` 轮询（1s）：`running / port / uptime / requests_total / errors_total / active_accounts`
- 状态灯三态扩展：`starting`（琥珀）/ `running`（mint）/ `error`（red，附最近错误）
- 新增**请求日志块**（最近 N 条：时间、端点、账号、状态码、耗时），由 `gateway_status` 附带最近事件环
- 多号池可视化：每号一行（名称 + 状态点 + 今日请求数 + 冷却剩余秒），数据从 pool 状态取
- 保存按钮启用规则：表单值 ≠ 持久值且服务未运行时才可点；运行中改配置需先停止（避免热改端口/密钥的不一致窗口）
- 样式约束：沿用 panel/hairline/amber/mint 主题变量，不新增配色；表单行复用 `.path-line`；全部文案走 `x.*` i18n 键（zh/en 同步）

## 5. 里程碑（每步可独立验证）

| # | 内容 | 验证 |
|---|---|---|
| M1 | 服务骨架：axum 起停 + `/v1/models` 静态列表 + Bearer 鉴权 + UI 按钮接线 | ✅ 已验（curl 401/200） |
| M2 | Anthropic messages 非流式：直通 + 前缀注入，真实出话 | ✅ 已验（Python 同构 200 出话） |
| M3 | OpenAI chat/completions 非流式 + 流式 SSE | ✅ 已验（多轮出 "5"、流式 42 chunk 出 "收到"） |
| M4 | /v1/responses + /v1/messages SSE 透传 + pool.rs 多号农场 | ✅ 已落（编译绿；端到端待客户端实测） |
| M5 | 面板请求日志/池可视化接线（pool 状态 → twoapi_status 扩展） | 未开工 |

## 6. 风险与前置

1. **前缀快照漂移（✅ 已验证 + 已定性，2026-10-31）**：3.16.3 → 3.17.1 system 前缀漂移实锤（2 段 2355c → 3 段 4799c，seg0 措辞变、seg1 重写、新增 seg2）。但**服务端白名单不认 3.17.1 新前缀**——实测对照：主线前缀（2 段 2355c）200 出话；3.17.1 新提取前缀 405/3012。**结论：白名单仍锚定 3.16.3 主线，gateway 内嵌主线前缀**（`src-tauri/src/gateway/assets/prefix.json`）。主线失效（3012）才需要重新校准，勿提前换新前缀。
2. **SSE 转换正确性**：三种客户端方言的流式事件差异（`[DONE]` vs events vs message_stop），需逐客户端实测。
3. **验证码管道存在、当前豁免（2026-10-31 反编译+实测定案）**：官方客户端在 start-plan 模式（`access.type===zhipu-account && access.mode===start-plan`）下，每次模型请求前会按 `client/configs` 的 `captcha` 配置解无痕验证码，把 `X-Aliyun-Captcha-Verify-Param/-Region` 作为 runtime headers 附到 messages 请求上（`send_preflight` 主动 + `captcha-retry` 被挑战后重试两源）。但当前服务端配置 `skip_model_request: true`（2026-10-31 实拉 client/configs），LOt 走豁免分支返回空 headers——今天的 chat 就是 Bearer + 版本头裸打。该豁免是服务端一行遥控配置：反代侧留一个探测点，定期拉 `client/configs` 读 `captcha.skip_model_request`，翻 false 时报警（届时接入 captcha_solve.js 同款无痕取票逻辑挂进 messages 头——取票参数与 claim 同一套：prefix `no8xfe`、region `cn`、sceneId `11xygtvd`，票值塞进 `X-Aliyun-Captcha-Verify-Param` + `X-Aliyun-Captcha-Region: cn`，挂点在 `upstream::headers()`）。在那之前：429/3012 不验证码，靠池冷却规避；出现 3007 类交互要求直接回错误（冷却表已有 3007→60s 兜底，见 §3）。
4. **Tauri 常驻线程与打包**：axum 在 Tauri runtime 里跑 tokio，注意端口占用冲突检测（与 dev 的 5173、zclaim 的 7861 错开）。
5. **头集最终形态（同账号 A/B 实锤，2026-11-01）**：messages **只发两条**——`Authorization: Bearer` + `Content-Type`。同一账号、同一 IP、同一份 body：全头族（`ZCode/3.17.1` UA + 版本头族 + `X-Device-Mid`）→ 3012；薄头 → 200（回复 "2"，usage in=524 out=31）。整族砍掉：版本/环境头族、`X-Device-Mid`、`HTTP-Referer`/`X-Title`、`x-request-id`，连 `User-Agent` 和 `anthropic-version` 都不发——
   - **头号嫌疑 = UA/TLS 指纹矛盾**：自称 Electron 客户端但 JA3 是 reqwest/rustls，bot 判定正打「装得像但握手露馅」；裸 Python-urllib UA 反而放行，不设 UA（reqwest 默认）明摆着非客户端也放行。`anthropic-version`：M3-E 与 A/B 两发 200 都没带，服务端不要求。
   - **落点**：`upstream.rs headers()` 默认薄头两条；全头族降级为归因实验开关 `ZCODE_GATEWAY_FULL_HEADERS=1`（发全族 + per-account mid，勿上真实流量）。版本头族（`zai_billing_headers`，[plan-08 §2](../../docs/zcode-plan-08-聊天对话接口.md)）只在 billing/touch 通道用；`cache_control` 与 `metadata.user_id` JSON 串形状两形态下均被接受，保留。`translate.rs` 前缀块的 `cache_control: ephemeral` 照发无害。
   - ⓘ M2 e2e 已在协议层闭环（farm 选号 → translate → 上游 → SSE 聚合全链 200 出话）；经 axum 服务的整链路验证待真实客户端接入时顺带完成。

   **M3-E（2026-10-31）**：Python 同构复刻仅带 `Authorization: Bearer` + `Content-Type` 两条头（无 UA、无版本头族）、system 无 `cache_control`、`metadata.user_id` 用 JSON 内嵌串——真实 200 出话。证明了「薄头 + 对齐的 body = 200」，但**当时「头集不是 3012 胜负手」的推论是错的**——它从未测全头族，头族敏感性由下面的 A/B 修正；②`cache_control` 形状服务端不校验；③`metadata.user_id` JSON 串形状被接受（Go 版对照存疑项关闭）。

   **⚠️ 新头集首打 3012（2026-10-31 23:5x，`scripts/farm_probe.py`）**：完整新链路单发即撞 405/3012——头族全开（`ZCode/3.17.1` UA + 版本头族 + `X-Device-Mid`=账号 virtual mid）+ 前缀块带 `cache_control` + 农场号 AaronWallace42。探针按全局风控档正确停手，未换号重试。与 M3-E 薄头集 200 逐项对差的结论：

   - **头号嫌疑 = UA/TLS 指纹矛盾**：M3-E 用裸 `Python-urllib` UA 过了，我自称 `ZCode/3.17.1` 被拒——声称 Electron 客户端但 TLS 指纹（JA3）是 Python 的，bot 判定正打这种「装得像但握手露馅」；明摆着非客户端的请求反而走普通鉴权路径放行。
   - **战略修正**：Rust 侧 reqwest+rustls 同样非 Chromium 指纹，「头族对齐官方」对 messages 可能整体是负资产；**M3-E 薄头集（Authorization + Content-Type）才是已验证 200 的形态**。归因完成前 gateway 默认薄头，版本头族退为实验开关。
   - 次级候选（未排除）：`X-Device-Mid` virtual mid 与账号绑定关系、farm 新号本 IP 首发-messages、`cache_control`（低嫌疑——官方 body 本就带，plan-08 §4）。
   - **M3-E「结论①头集不是胜负手」就此修正**：它只证了「薄头+好 body=200」，从未测全头族；本发补上「全头族+好 body=3012」。
   - bisect 定案（2026-11-01 00:0x，一发收口）：**同账号 A/B 实锤头族**。AaronWallace42（10-31 撞 3012 的同一个号、同一个 IP、同一份 body）仅把头集换成薄头（`--thin`）→ **HTTP 200，回复 "2"，usage in=524 out=31**。账号/virtual mid/farm 新号三个候选全部洗清，唯一变量 = 头族。3012 判定的机理确认为「头族自称 Electron 客户端 vs TLS 指纹（JA3）矛盾」一类 bot 检查。

   **逐组 bisect 定位扳机（2026-11-01 00:1x，`scripts/header_bisect.py`，三轮 6 发收工）**：薄头基座按嫌疑度降序逐组叠加、每组换号。①基线 thin（AaronWallace42）→ 200 出话；②叠加 `User-Agent: ZCode/3.17.1` 单独一组（NazSuno19142）→ **405/3012**；③排除 UA 后叠加版本头族（X-ZCode-App-Version/X-Platform/X-Release-Channel/X-Os-*/X-Client-*）→ **同样 405/3012**（独立扳机，无 UA 亦死）；④排除两组后剩余四组逐组叠加全过：`HTTP-Referer`+`X-Title` → `X-Device-Mid`（账号 virtual mid）→ `x-request-id` → `anthropic-version`，**每组一发全部 200 出话**。定案：扳机 = 一切「自称官方客户端版本」的头（UA / 版本头族），机理 = 与非 Chromium TLS 指纹的矛盾判定；无害头全部安全。

   **头集最终定案（2026-11-01）**：`upstream.rs` 默认 = 实测安全集——`Authorization` + `Content-Type` + `HTTP-Referer` + `X-Title` + **`X-Device-Mid`（per-account virtual mid，farm 设备分化成立）** + `x-request-id` + `anthropic-version`；UA 与版本头族被禁（`ZCODE_GATEWAY_FULL_HEADERS=1` 仅归因实验），换 Chromium 指纹层（curl-impersonate 类）后才值得整套重评。`cache_control` 与 `metadata.user_id` 保留（各形态均被接受）。ⓘ M2 e2e 在协议层闭环（farm 选号→translate→上游→SSE 聚合全链 200 出话），经 axum 服务的整链路验证待真实客户端接入时顺带完成。
