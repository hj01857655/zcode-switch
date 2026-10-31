# GATEWAY — Rust 版 2API 设计文档

> 目标：在 zcode-switch（Tauri）内嵌 OpenAI/Anthropic 兼容反代，复用本工具现成的多号凭据体系，替代旁挂 `ZCode2api-go` 独立进程。
> 参考实现：`ZCode2api-go`（Go，~2.6k 行，协议已验证）。本文是其 Rust 翻译的设计与分解。
> 状态：**M1 已落地，M2（/v1/messages 直通）已实现、未 e2e**（2026-10-31：`src-tauri/src/gateway/` mod/server/translate/upstream/config 共 530 行；UI 骨架 `views/gateway.jsx`，commit `2183856`）。

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
| 3007（captcha verify failed） | 0（直接返回不换号；upstream.rs 现状落「其他」档。当前靠服务端 `skip_model_request:true` 不会出现；若豁免翻 false 即确定性拒绝，固定 JWT 无限重打有指纹风险——届时改冷却或接取票，见 §6.3） |
| 其他 | 0（直接返回，不换号） |

策略：失败换下一号，冷却期内跳过；全部耗尽回 503。`window_test.go` 里有窗口调度测试，Rust 版同构。

## 4. 模块分解（Rust 侧新增）

```
src-tauri/src/gateway/
  mod.rs        — GatewayCtl：启停线程、状态共享（AtomicBool + 端口/密钥配置）
  server.rs     — axum 路由 + Bearer 鉴权 + health
  translate.rs  — 三协议 ⇄ anthropic（请求/响应/SSE 双向）
  pool.rs       — 多号轮询 + 冷却（读 store 凭据）
  upstream.rs   — z.ai messages 客户端（reqwest + SSE 流式解析）
```

依赖新增：`axum`（或 tiny-http + 手路由）、`tokio`（Tauri 已带）、`reqwest` stream。IPC 命令：`gateway_start` / `gateway_stop` / `gateway_status`，配置落 `~/.zcode-switch/gateway.json`（端口、sk-… 密钥）。

## 4b. 前端设计（已落骨架：`views/gateway.jsx`，commit `2183856`）

控制面板复用关于页的居中卡片视觉（`.about-card.gateway-card`），自上而下四段：

1. **品牌行**：`2API` 大字 mono + 状态徽标（`已停止` 灰 / `运行中` mint 绿，随状态轮询变色）
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
| M1 | 服务骨架：axum 起停 + `/v1/models` 静态列表 + Bearer 鉴权 + UI 按钮接线 | curl 能 401/200 |
| M2 | Anthropic messages 非流式：直通 + 前缀注入 + 单号，真实出话 | curl 单轮对话 |
| M3 | OpenAI chat/completions 非流式 + 流式 SSE | 任意 OpenAI 客户端连上 |
| M4 | /v1/responses + /v1/messages SSE | Codex / Claude Code 连上 |
| M5 | 多号池 + 冷却 + 面板状态/日志展示 | 多号切换日志可见 |

## 6. 风险与前置

1. **前缀快照漂移（✅ 已验证 + 已定性，2026-10-31）**：3.16.3 → 3.17.1 system 前缀漂移实锤（2 段 2355c → 3 段 4799c，seg0 措辞变、seg1 重写、新增 seg2）。但**服务端白名单不认 3.17.1 新前缀**——实测对照：主线前缀（2 段 2355c）200 出话；3.17.1 新提取前缀 405/3012。**结论：白名单仍锚定 3.16.3 主线，gateway 内嵌主线前缀**（`src-tauri/src/gateway/assets/prefix.json`）。主线失效（3012）才需要重新校准，勿提前换新前缀。
2. **SSE 转换正确性**：三种客户端方言的流式事件差异（`[DONE]` vs events vs message_stop），需逐客户端实测。
3. **验证码管道存在、当前豁免（2026-10-31 反编译+实测定案）**：官方客户端在 start-plan 模式（`access.type===zhipu-account && access.mode===start-plan`）下，每次模型请求前会按 `client/configs` 的 `captcha` 配置解无痕验证码，把 `X-Aliyun-Captcha-Verify-Param/-Region` 作为 runtime headers 附到 messages 请求上（`send_preflight` 主动 + `captcha-retry` 被挑战后重试两源）。但当前服务端配置 `skip_model_request: true`（2026-10-31 实拉 client/configs），LOt 走豁免分支返回空 headers——今天的 chat 就是 Bearer + 版本头裸打。该豁免是服务端一行遥控配置：反代侧留一个探测点，定期拉 `client/configs` 读 `captcha.skip_model_request`，翻 false 时报警（届时接入 captcha_solve.js 同款无痕取票逻辑挂进 messages 头）。在那之前：429/3012 不验证码，靠池冷却规避；出现 3007 类交互要求直接回错误。
4. **Tauri 常驻线程与打包**：axum 在 Tauri runtime 里跑 tokio，注意端口占用冲突检测（与 dev 的 5173、zclaim 的 7861 错开）。
5. **头集薄于官方实录，本仓未独立 e2e（2026-10-31 对照审查）**：`upstream.rs:21` 只发 Bearer + `anthropic-version` + UA；官方 model-io 实录另有 `x-zcode-app-version`/`x-release-channel`/`x-client-language`/`x-platform`/`x-os-category`/`x-request-id` 等版本头族（[plan-08 §2](../../docs/zcode-plan-08-聊天对话接口.md)，quota.rs 的 `zai_billing_headers` 已有现成实现可复用）。UA 发的 `ZCode/3.17.1 ai-sdk/anthropic/3.0.81` 既非桌面形态（裸 `ZCode/3.17.1`，host 组装）也非 CLI 形态（`ai-sdk/provider-utils/… runtime/node.js/22`）。手搓最小头集实测 405+3012 被 WAF 拒（2026-10-31），本仓这套薄头集能否过闸押注在「Go 版 client.go 同款头集已跑通」这条间接证据上——M2 首发真实出话前先补版本头族再验。另有一处形状差异：`translate.rs:58` 注入的 system 前缀块无 `cache_control`（对齐 Go 版有意省略），官方 body 逐块带 `{"type":"ephemeral"}`（plan-08 §4）。
