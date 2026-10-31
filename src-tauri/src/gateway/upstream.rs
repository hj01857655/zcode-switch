// GATEWAY 上游客户端：z.ai anthropic messages 端点调用（SSE 响应透传）
// 协议对齐 ZCode2api-go internal/zcode/client.go：头集、一律 stream=true、错误分类冷却。
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

/// 上游请求头全集：版本头族复用 quota 的真实探测实现（zcode_app_version/平台/设备 mid），
/// 补 messages 专用头。官方桌面实录含 x-zcode-app-version 族与 x-request-id（plan-08 §2）。
pub fn headers(token: &str) -> Vec<(String, String)> {
    let mut h = crate::quota::zai_billing_headers(token);
    h.push(("Content-Type".into(), "application/json".into()));
    h.push(("anthropic-version".into(), "2023-06-01".into()));
    h
}

/// 发送 anthropic body（上游一律 stream=true，由调用侧聚合或透传）。
/// 返回原始字节流交给上层解析——M2 非流式聚合，M4 直接透传 SSE。
pub async fn messages(
    http: &HttpClient,
    token: &str,
    body: &[u8],
) -> Result<bytes::Bytes, UpstreamError> {
    let mut req = http.post(UPSTREAM_MESSAGES);
    for (k, v) in headers(token) {
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
    resp.bytes()
        .await
        .map_err(|e| UpstreamError { status: 0, body: e.to_string() })
}

/// 流式版：返回原始响应体（M3/M4 SSE 逐块转发，调用侧自行解析）
pub async fn messages_stream(
    http: &HttpClient,
    token: &str,
    body: &[u8],
) -> Result<reqwest::Response, UpstreamError> {
    let mut req = http.post(UPSTREAM_MESSAGES);
    for (k, v) in headers(token) {
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

/// 冷却时长（秒）：0 = 不冷却不换号。Go client.go:134 对齐。
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
