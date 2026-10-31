# TWOAPI — Rust 版 2API 设计文档

> 目标：在 zcode-switch（Tauri）内嵌 OpenAI/Anthropic 兼容反代，复用本工具现成的多号凭据体系，替代旁挂 `ZCode2api-go` 独立进程。
> 参考实现：`ZCode2api-go`（Go，~2.6k 行，协议已验证）。本文是其 Rust 翻译的设计与分解。
> 状态：**设计稿，未开工**。UI 骨架已落（`views/twoapi.jsx`，commit `2183856`）。

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
│  Webview UI ──(start/stop/status IPC)──► TwoApiCtl │
│                                        │           │
│  [twoapi 模块, 独立线程]                ▼           │
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
| 其他 | 0（直接返回，不换号） |

策略：失败换下一号，冷却期内跳过；全部耗尽回 503。`window_test.go` 里有窗口调度测试，Rust 版同构。

## 4. 模块分解（Rust 侧新增）

```
src-tauri/src/twoapi/
  mod.rs        — TwoApiCtl：启停线程、状态共享（AtomicBool + 端口/密钥配置）
  server.rs     — axum 路由 + Bearer 鉴权 + health
  translate.rs  — 三协议 ⇄ anthropic（请求/响应/SSE 双向）
  pool.rs       — 多号轮询 + 冷却（读 store 凭据）
  upstream.rs   — z.ai messages 客户端（reqwest + SSE 流式解析）
```

依赖新增：`axum`（或 tiny-http + 手路由）、`tokio`（Tauri 已带）、`reqwest` stream。IPC 命令：`twoapi_start` / `twoapi_stop` / `twoapi_status`，配置落 `~/.zcode-switch/twoapi.json`（端口、sk-… 密钥）。

## 5. 里程碑（每步可独立验证）

| # | 内容 | 验证 |
|---|---|---|
| M1 | 服务骨架：axum 起停 + `/v1/models` 静态列表 + Bearer 鉴权 + UI 按钮接线 | curl 能 401/200 |
| M2 | Anthropic messages 非流式：直通 + 前缀注入 + 单号，真实出话 | curl 单轮对话 |
| M3 | OpenAI chat/completions 非流式 + 流式 SSE | 任意 OpenAI 客户端连上 |
| M4 | /v1/responses + /v1/messages SSE | Codex / Claude Code 连上 |
| M5 | 多号池 + 冷却 + 面板状态/日志展示 | 多号切换日志可见 |

## 6. 风险与前置

1. **前缀快照漂移**（最大项）：`prefix.json` 提取自 3.16.3；3.17.1 的 system 前缀是否变化未验证。M2 前必须先做一次提取比对（Go 版 `SystemPrefix()` 的提取流程有文档）。
2. **SSE 转换正确性**：三种客户端方言的流式事件差异（`[DONE]` vs events vs message_stop），需逐客户端实测。
3. **与 claim 共用 captcha**：上游 429/3012 时反代侧不验证码，靠池冷却规避；出现 3007 类交互要求直接回错误。
4. **Tauri 常驻线程与打包**：axum 在 Tauri runtime 里跑 tokio，注意端口占用冲突检测（与 dev 的 5173、zclaim 的 7861 错开）。
