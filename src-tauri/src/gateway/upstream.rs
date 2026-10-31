// GATEWAY 上游客户端：z.ai anthropic messages 端点调用（SSE 响应透传）
// 一律 stream=true、错误分类冷却。头集策略见 headers()：默认薄头（M3-E 实测形态）。
use reqwest::Client as HttpClient;

/// 上游 messages 端点（协议文档 docs/CLAIM.md / GATEWAY.md §2）
pub const UPSTREAM_MESSAGES: &str =
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";

pub struct UpstreamError {
    pub status: u16,
    pub body: String,
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "upstream {}: {}", self.status, self.body)
    }
}

/// messages 头集（2026-11-01 版本门限定案）：WAF 对「版本自述」按版本号分档——
/// 3.17.1（最新）触发严格 bot 检查（UA 与 X-ZCode-App-Version 均单条实锤 3012，
/// scripts/header_bisect.py + version_family_bisect.py）；≤3.16.3 放行（3.14.0 两条、
/// 全头族 3.16.3 均实测 200）。故整套官方头族回归、版本钉死 3.16.3——与 body 主线
/// 前缀同版本代际。版本号可用 ZCODE_GATEWAY_APP_VERSION 覆盖做归因实验；
/// billing/touch 通道仍走 quota.rs 的注册表真实探测（那边 3.17.1 才能拿投放）。
const SAFE_APP_VERSION: &str = "3.16.3";

pub fn headers(token: &str, mid: Option<&str>) -> Vec<(String, String)> {
    let ver = std::env::var("ZCODE_GATEWAY_APP_VERSION")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| SAFE_APP_VERSION.to_string());
    let mut h: Vec<(String, String)> = vec![
        ("User-Agent".into(), format!("ZCode/{ver}")),
        ("HTTP-Referer".into(), "https://zcode.z.ai".into()),
        ("X-Title".into(), "Z Code@electron".into()),
        ("X-ZCode-App-Version".into(), ver.clone()),
        ("X-Platform".into(), crate::quota::client_platform()),
        ("X-Release-Channel".into(), "stable".into()),
        ("X-Os-Category".into(), std::env::consts::OS.into()),
        ("X-Client-Language".into(), "zh-CN".into()),
        ("X-Client-Timezone".into(), crate::quota::client_timezone()),
        ("anthropic-version".into(), "2023-06-01".into()),
        ("Authorization".into(), format!("Bearer {token}")),
        ("x-request-id".into(), uuid::Uuid::new_v4().to_string()),
        ("Content-Type".into(), "application/json".into()),
    ];
    if let Some(v) = crate::quota::os_version() {
        h.push(("X-Os-Version".into(), v));
    }
    if let Some(m) = mid {
        h.push(("X-Device-Mid".into(), m.to_string()));
    }
    h
}

/// 发送 anthropic body（上游一律 stream=true）。返回原始响应：M2 非流式由调用侧
/// bytes().await 聚合，M3/M4 直接逐块转发 SSE。
pub async fn messages_stream(
    http: &HttpClient,
    token: &str,
    mid: Option<&str>,
    body: &[u8],
) -> Result<reqwest::Response, UpstreamError> {
    let mut req = http.post(UPSTREAM_MESSAGES);
    for (k, v) in headers(token, mid) {
        req = req.header(k, v);
    }
    let resp = req
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| UpstreamError { status: 0, body: e.to_string() })?;
    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(4096)
            .collect();
        return Err(UpstreamError { status, body });
    }
    Ok(resp)
}

/// 冷却时长（秒）：0 = 不冷却不换号。
pub fn cooldown_secs(status: u16, body: &str) -> u64 {
    match status {
        401 => 30 * 60,            // token 失效
        429 => 60,                 // 限流/额度
        405 => 10 * 60,            // 风控
        _ if body.contains("3012") => 10 * 60,
        _ if body.contains("3007") => 60, // 安全验证：body code（HTTP 400），确定性拒绝，不冷却会拿固定 JWT 无限重打
        _ if body.contains("3008") || body.contains("3009") || body.contains("3010") => 60,
        _ => 0,
    }
}

/// 3012/405 是 IP+指纹级风控：不只冷却单号，整个农场全局退避并立即放弃本次请求
pub fn is_global_risk(status: u16, body: &str) -> bool {
    status == 405 || body.contains("3012")
}

/// 该错误是否值得换号重放一轮（业务性/瞬时错误）
pub fn is_retryable(status: u16, body: &str) -> bool {
    status == 0 // 网络错误
        || status == 429
        || body.contains("3008")
        || body.contains("3009")
        || body.contains("3010")
}
