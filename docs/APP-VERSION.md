# ZCode 客户端版本头策略

一句话：本工具对上游发的每个请求都带 ZCode 客户端版本号。**billing/claim 对版本不敏感**（3.14.0 与 3.17.1 实测均通），全部通道统一走**探测版本**（注册表读本机实际安装的 ZCode 版本）；唯一例外是 `marketing/touch` 的历史教训——老版本头返回空 deliveries，但那同样被探测值覆盖，因此**没有任何通道需要硬编码版本**。

## 版本源

| 来源 | 值 | 位置 | 说明 |
|---|---|---|---|
| `zcode_app_version()` | 探测值（如 `3.17.1`） | `src-tauri/src/quota.rs:133` | 遍历注册表卸载表项取 ZCode 的 DisplayVersion，`OnceLock` 进程级缓存；探测失败回落 `CLIENT_APP_VERSION` |
| `CLIENT_APP_VERSION` | `"3.17.1"` | `src-tauri/src/quota.rs:23` | 仅作探测兜底，与探测目标同步维护 |
| ~~`CLAIM_APP_VERSION`~~ | 已删除 | —— | 曾钉 `"3.14.0"`（生态流传防 3012），2026-10-31 实测推翻，见下 |

请求头里 `User-Agent: ZCode/<ver>` 与 `X-ZCode-App-Version: <ver>` 同源，由 `zai_headers_with_version` 统一拼装（`quota.rs:205`）。

## 通道矩阵（全部走探测值）

| 通道 | 生效位置 |
|---|---|
| 模型请求 UA（bigmodel） | `quota.rs:231` |
| 额度 billing/balance（头 + URL 参数） | `quota.rs:194`（头）、`quota.rs:480/715`（URL） |
| 探测通道 probe | `probe.rs:194`（URL）、`probe.rs:238`（头） |
| OAuth（头 + redirect_uri 参数） | `quota.rs:204`、`oauth.rs:25` |
| 领取 preview/claim（头 + URL 参数） | `claim.rs:227/372/408`（`zai_billing_headers_with_mid`，同探测值） |
| 营销投放 marketing/touch（头 + URL） | `claim.rs:266/271`——此端点对 `app_version` 敏感，老版本头返回空 deliveries，探测值天然满足 |
| 激活补报 event/report（body `app_version`） | 已从流程移除（[50 号 §2.5](../../ZCode/docs/zcode-plan-50-领取双通道-每日自动与周末卡.md)：上报与投放/领取零因果） |
| 账号切换写回 | `store.rs:910` |

## 「领取通道固定 3.14.0 防 3012」的证伪（2026-10-31）

**旧说法**：领取（billing/preview、billing/claim）版本头换成高版本会触发 3012 风控，故钉死 3.14.0。出处是 `ZCode2api-go/docs/CLAIM.md` 的约定与两份参考实现同值。

**实测推翻**：以 `3.17.1` 作 `User-Agent` + `X-ZCode-App-Version` + URL 参数直打 `billing/claim`（带新鲜 captchaVerifyParam、本号 mid），**连续 12 个账号全部成功**（code 0，5 亿 `1030-wk` 桶到账），零 3012。同批 `billing/balance`、`captcha` 链（`client/configs` → 阿里 SDK → param）同样全程 3.17.1。

- 12 号清单与落盘输出：ShannonYoung8131（`upl_2116247031258935296`）、AaronWallace42、NazSuno19142、us3l5jyu、RobertoSantos6003、及此前 zai/bigmodel 双渠道号
- 脚本：`ZCode/tools/claim_touch_s02j0pwh.py`（`VER = "3.17.1"`）

**结论**：billing 链对版本头不敏感（至少 3.14.0 与 3.17.1 都通），`CLAIM.md` 的「固定 3.14.0」是生态互相抄的保守惯例、无对照实验依据。**真正对版本敏感的是 `marketing/touch`**（老版本头 → 空 deliveries），而它恰好必须用真实版本才能拿到投放——统一探测版本同时满足两者。

## 历史（P0 修复，2026-10-30；2026-10-31 部分推翻）

P0 修复的问题本身成立：`CLIENT_APP_VERSION` 硬编码 `"3.11.2"` 早已过时（本机实际装 3.16.3，注册表实测）；同一客户端双版本源并存（billing 走探测、OAuth 走 3.11.2）有一致性风控隐患。修复引入的 `CLAIM_APP_VERSION` 钉 3.14.0 则是**过度设计**——基于未验证的生态说法。2026-10-31 修复：删除该常量与 `zai_claim_headers_with_mid`，billing/claim 两处调用点切回 `zai_billing_headers_with_mid`（探测值），全部通道版本源归一。

## 维护守则

- **ZCode 升级**：只改 `CLIENT_APP_VERSION` 兜底值，探测自动跟随实际安装（兜底值 2026-10-31 已随本机 ZCode 3.17.1 同步）
- **不要再给任何通道加专用版本常量**：除非有「该通道版本头换成 X → 明确报错 Y」的对照实验记录
- 探测结果 `OnceLock` 缓存于进程生命周期，ZCode 升级后本工具需重启才会用新版本号（已知限制，P2）
