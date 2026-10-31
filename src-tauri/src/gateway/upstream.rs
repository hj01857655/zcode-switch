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

/// 上游请求头全集（Go client.go:75 对齐；版本随本机 3.17.1）
pub fn headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".into(), format!("Bearer {token}")),
        ("Content-Type".into(), "application/json".into()),
        ("anthropic-version".into(), "2023-06-01".into()),
        ("User-Agent".into(), "ZCode/3.17.1 ai-sdk/anthropic/3.0.81".into()),
    ]
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

/// 冷却时长（秒）：0 = 不冷却不换号。Go client.go:134 对齐。
pub fn cooldown_secs(status: u16, body: &str) -> u64 {
    match status {
        401 => 30 * 60,            // token 失效
        429 => 60,                 // 限流/额度
        405 => 10 * 60,            // 风控
        _ if body.contains("3012") => 10 * 60,
        _ if body.contains("3008") || body.contains("3009") || body.contains("3010") => 60,
        _ => 0,
    }
}
