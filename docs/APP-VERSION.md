# ZCode 客户端版本头策略

一句话：本工具对上游发的每个请求都带 ZCode 客户端版本号，但**不是同一个版本**——模型/额度/OAuth 通道跟随本机实际安装的 ZCode 版本（注册表探测），**领取通道（billing/preview、billing/claim）固定 3.14.0**。领取通道换更高版本实测触发上游 3012 风控。

## 三个版本源

| 来源 | 值 | 位置 | 说明 |
|---|---|---|---|
| `zcode_app_version()` | 探测值（如 `3.16.3`） | `src-tauri/src/quota.rs:136` | 遍历注册表卸载表项取 ZCode 的 DisplayVersion，`OnceLock` 进程级缓存；探测失败回落 `CLIENT_APP_VERSION` |
| `CLIENT_APP_VERSION` | `"3.16.3"` | `src-tauri/src/quota.rs:23` | 仅作探测兜底，与探测目标同步维护 |
| `CLAIM_APP_VERSION` | `"3.14.0"` | `src-tauri/src/quota.rs:27` | 领取通道专用固定版本，**不跟随探测** |

请求头里 `User-Agent: ZCode/<ver>` 与 `X-ZCode-App-Version: <ver>` 同源，由 `zai_headers_with_version` 统一拼装（`quota.rs:206`）。

## 通道矩阵

| 通道 | 版本来源 | 生效位置 |
|---|---|---|
| 模型请求 UA（bigmodel） | 探测 | `quota.rs:233` |
| 额度 billing/balance（头 + URL 参数） | 探测 | `quota.rs:194`（头）、`quota.rs:479/714`（URL） |
| 探测通道 probe | 探测 | `probe.rs:194/244` |
| OAuth（头 + redirect_uri 参数） | 探测 | `quota.rs:204`、`oauth.rs:25` |
| 激活补报 event/report（body `app_version`） | 探测 | `claim.rs:170` |
| 账号切换写回 | 探测 | `store.rs:910` |
| **领取 preview/claim（请求头）** | **3.14.0 固定** | `quota.rs:198` → `claim.rs:249/287` |
| 领取 preview URL 参数 | 探测 ⚠️ | `claim.rs:227`（见「已知不一致」） |

## 为什么领取通道固定 3.14.0

领取通道的版本换成更高值（如探测到的 3.16.3）会触发上游 **3012 风控**（unusual activity）。协议证据与请求样本见 [ZCode2api-go/docs/CLAIM.md](../../ZCode2api-go/docs/CLAIM.md)；两份参考实现同值：Go `internal/zcode/claim.go:27` `ClaimAppVer = "3.14.0"`、Node `tools/claim_check.js:21` 默认 `3.14.0`（可用环境变量 `ZCODE_APPVER` 覆盖）。模型请求侧不受此限——`ZCode2api-go/internal/zcode/client.go:80` 用 3.16.3 正常出话。

## 历史（P0 修复，2026-10-30）

修复前两个问题：`CLIENT_APP_VERSION` 硬编码 `"3.11.2"` 早已过时（本机实际装 3.16.3，注册表实测）；且同一客户端双版本源并存——billing 走探测值、OAuth 走硬编码 3.11.2，上游做版本一致性校验时易触发风控。

修复三处：

1. 兜底常量 `3.11.2 → 3.16.3`（对齐本机注册表实测）
2. OAuth 头改用 `zcode_app_version()`（`oauth.rs:25` 的 redirect_uri 同步）
3. 领取通道从 billing 头拆出 `zai_claim_headers_with_mid`，固定 `CLAIM_APP_VERSION = "3.14.0"`；`claim.rs` 两处调用点（preview、submit）切换到该头

## 维护守则

- **ZCode 升级**：只改 `CLIENT_APP_VERSION` 兜底值，探测自动跟随实际安装
- **`CLAIM_APP_VERSION` 别跟探测走**：只在有实测证据表明官方领取通道版本基线变更后才动；跟探测 = 3012
- 探测结果 `OnceLock` 缓存于进程生命周期，ZCode 升级后本工具需重启才会用新版本号（已知限制，P2）

## 已知不一致（待定夺）

`claim.rs:227` preview URL 的 `app_version` 参数仍取探测值（如 3.16.3），与同请求的头 `X-ZCode-App-Version: 3.14.0` 不同源。两份参考实现的 preview URL 参数均为 3.14.0（`claim.go:223`、`claim_check.js:196`），且 `quota.rs:27` 的注释意图（「领取通道固定版本」）按理也覆盖 URL 参数。P0 修复未覆盖此处；3012 是否会由 URL 参数触发未实测，留待领取实测时一并定夺。
