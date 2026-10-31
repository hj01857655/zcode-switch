# ZCode 客户端版本头策略

一句话：本工具对上游发的每个请求都带 ZCode 客户端版本号，**全部通道统一走探测版本**（注册表读本机实际安装的 ZCode 版本，当前 3.17.1），无任何通道需要硬编码版本。

## 版本源

| 来源 | 值 | 位置 | 说明 |
|---|---|---|---|
| `zcode_app_version()` | 探测值（如 `3.17.1`） | `src-tauri/src/quota.rs:133` | 遍历注册表卸载表项取 ZCode 的 DisplayVersion，`OnceLock` 进程级缓存；探测失败回落 `CLIENT_APP_VERSION` |
| `CLIENT_APP_VERSION` | `"3.17.1"` | `src-tauri/src/quota.rs:23` | 仅作探测兜底，与探测目标同步维护 |

请求头里 `User-Agent: ZCode/<ver>` 与 `X-ZCode-App-Version: <ver>` 同源，由 `zai_headers_with_version` 统一拼装（`quota.rs:205`）。

## 通道矩阵（全部走探测值）

| 通道 | 生效位置 |
|---|---|
| 模型请求 UA（bigmodel） | `quota.rs:231` |
| 额度 billing/balance（头 + URL 参数） | `quota.rs:194`（头）、`quota.rs:480/715`（URL） |
| 探测通道 probe | `probe.rs:194`（URL）、`probe.rs:238`（头） |
| OAuth（头 + redirect_uri 参数） | `quota.rs:204`、`oauth.rs:25` |
| 领取 preview/claim（头 + URL 参数） | `claim.rs:227/372/408`（`zai_billing_headers_with_mid`） |
| 营销投放 marketing/touch（头 + URL） | `claim.rs:266/271`——此端点对 `app_version` 敏感，老版本头返回空 deliveries，探测值天然满足 |
| 账号切换写回 | `store.rs:910` |

## 历史

- 2026-10-30（P0）：修复 `CLIENT_APP_VERSION` 硬编码过时（本机实际装 3.16.3，注册表实测）、OAuth 与 billing 双版本源并存的一致性隐患。
- 2026-10-31：实测确认各通道对版本头均不敏感，删除领取通道专用版本常量，全部通道版本源归一至探测值。
- 2026-10-31：实测确认 billing 链对版本头不敏感（3.17.1 头 + URL 直打 `billing/claim` 连续 12 个账号全部成功），删除 `CLAIM_APP_VERSION` 与 `zai_claim_headers_with_mid`，billing/claim 两处调用点切回 `zai_billing_headers_with_mid`（探测值），全部通道版本源归一。

## 维护守则

- **ZCode 升级**：只改 `CLIENT_APP_VERSION` 兜底值，探测自动跟随实际安装
- **不要再给任何通道加专用版本常量**：除非有「该通道版本头换成 X → 明确报错 Y」的对照实验记录
- 探测结果 `OnceLock` 缓存于进程生命周期，ZCode 升级后本工具需重启才会用新版本号（已知限制，P2）
