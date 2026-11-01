# Z·SWITCH (zcode-switch)

**简体中文** ｜ [English](README.en.md)

> **项目来源**：本仓库是 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch) 的 fork，在其基础上持续开发（安全加固、额度体系、本地网关等增强见下）。上游的原始设计与核心架构归功于原作者；本 fork 的全部增量以同 License（MIT）回馈社区，向上游的 issue/PR 欢迎各取所需。

Tauri 2 桌面工具：在多个 ZCode 账号之间一键切换，自动显示额度。只换登录身份——项目、会话、设置全部共用不动。

![screenshot](docs/screenshot.png)

## 功能

- **保存 / 切换账号**：一键切换登录身份；切换前自动保全当前登录，绝不丢号；设备身份跟账号走，远程控制中继密钥跨切换保活
- **添加账号**：工具内 OAuth 登录新号（BigModel / z.ai 双入口），全程不动当前登录
- **额度展示**：账号行内联显示套餐额度与重置时间，多套餐分组；仪表盘页汇总总览
- **活动领取**：可领套餐一键领取；「自动领取」开关（默认关）定时自动检测并领取，手动操作优先
- **本地网关**：OpenAI 兼容反代，把任意 OpenAI SDK 的请求翻译成 ZCode 模型端点协议（`http://127.0.0.1:8081/v1`）；多账号池轮询 + 冷却、请求日志（原文/JSON/正文/SSE 多格式查看）、网关配置调优弹窗、冒烟测试弹窗（协议切换 / System / 参数 / 流式 / curl 预览）；详见 [docs/GATEWAY.md](docs/GATEWAY.md)
- **邀请计划**：绑定邀请码、我的邀请码与分享链接（复制完整链接）、邀请任务进度一览
- **加密导入导出**：`.zsb` 捆绑包，PBKDF2(600k) + AES-256-GCM 口令加密
- **中英双语**：设置里一键切换 中文 / English，主窗、托盘、错误提示、CLI 输出全覆盖；首次运行按系统语言自动选择
- **托盘 / 开机自启 / CLI 自动化**

## 安全设计

- **本地优先**：所有数据在本地，无遥测、无远端存储；额度查询直连官方接口
- **WebView CSP**：主窗/设置窗 `script-src 'self'`（无 eval、无第三方脚本域），仅验证码子窗为阿里验证码 SDK 放行 `o.alicdn.com` 与 `unsafe-eval`；`img-src` 收敛至阿里 CDN；本地页面以 meta CSP 二次收口
- **防丢号**：切换前自动保全未入库登录；文件写入走临时文件 + 原子 rename
- **路径穿越防护**：账号 id 白名单（`[A-Za-z0-9-]`），删除/读取均不可逃出账号库目录
- **加密导出**：PBKDF2-HMAC-SHA256（600k 迭代，OWASP 2025 基线；v1 旧包 100k 仍可导入）+ AES-256-GCM，随机 salt/nonce；错密码即失败，无明文痕迹
- **凭据只在本地解密**：凭据解密仅用于显示用户名/邮箱；导出文件凭口令加密

## CLI

```
zcode-switch.exe --cli state|list
zcode-switch.exe --cli quota [--id <账号id>]
zcode-switch.exe --cli claim-preview [--id <账号id>]
zcode-switch.exe --cli capture [--name 名称]
zcode-switch.exe --cli switch --id <id> [--force] [--restart|--no-restart] [--hot <bool>|--no-hot]
zcode-switch.exe --cli kill
zcode-switch.exe --cli export --id <id> --out <a.zsb>
zcode-switch.exe --cli export-all --out <all.zsb>
zcode-switch.exe --cli import --file <file.zsb>
zcode-switch.exe --cli rename|delete|update|behavior|setpath|launch
zcode-switch.exe --cli gateway status               # 网关配置 + 端口监听探测（启停在 GUI）
zcode-switch.exe --cli gateway logs [--n 条数]      # 读 gateway.jsonl 尾部请求日志
zcode-switch.exe --cli --lang en state              # 英文输出（--lang 空格传值、可置于任意位置；默认跟 GUI 语言/系统语言）
```

CLI 密码（export / import）：优先环境变量 `ZSW_PASSWORD`（不出现在进程列表和命令历史），也可 `--password <密码>`。

## 常见问题

### macOS 弹出「麦克风 / 辅助功能 / 录屏」权限询问？

全部拒绝即可，不影响任何功能。
应用内嵌的登录等网页由系统 WebView 渲染，网页发起的请求会被透传为应用的系统权限询问；应用本体与其内嵌网页均未使用这三项能力。

## 开发文档

- [客户端版本头策略](docs/APP-VERSION.md)——全部通道跟随本机 ZCode 版本（注册表探测）；billing 链版本不敏感（2026-10-31 实测 3.17.1 连续 12 号 claim 零 3012），marketing/touch 必须真实版本（老版本头回空投放）
- [网关设计文档](docs/GATEWAY.md)——协议矩阵、多号池、模块分解与里程碑

## 构建

```bash
npm install
npm run tauri dev      # 开发（HMR）
npm run tauri build    # NSIS 安装包
```

Windows 优先（路径探测 / 进程管理 / 托盘均为 Win32 语义）。

## License

[MIT](./LICENSE)——上游原作（pjpv）与本 fork 增强的版权行均在 LICENSE 内；衍生分发请保留两行。
