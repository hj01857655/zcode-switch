// GATEWAY HTTP 服务：axum 路由 + Bearer 鉴权 + health + /v1/models 静态列表
// M2-M3：/v1/messages 直通聚合；/v1/chat/completions OpenAI 转换（非流式聚合 + SSE 流式）。
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::{openai, pool, translate, upstream};

struct SvcState {
    api_key: String,
    http: reqwest::Client,
    /// 换号重试次数（首次尝试之外，配置面）
    max_retries: u32,
    /// 全局风控退避秒数（配置面）
    backoff_secs: u64,
    /// 跨线程共享：pool 调度器 + 请求日志环 + 计数（twoapi_status 经 TwoApiState 读取）
    shared: std::sync::Arc<super::GatewayShared>,
}

pub async fn serve(
    addr: std::net::SocketAddr,
    cfg: super::config::GatewayConfig,
    mut shutdown: watch::Receiver<bool>,
    shared: std::sync::Arc<super::GatewayShared>,
) {
    // 连接超时可配；不设整体读超时——SSE 流式回答持续数分钟是正常形态
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(cfg.upstream_connect_secs))
        .build()
        .expect("gateway http client");
    let max_retries = cfg.max_retries;
    let backoff_secs = cfg.global_backoff_secs;
    let cors_origins = cfg.cors_origins.clone();
    shared.pool.set_sticky(cfg.sticky);
    let state = std::sync::Arc::new(SvcState {
        api_key: cfg.api_key,
        http,
        max_retries,
        backoff_secs,
        shared,
    });
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/messages", post(messages))
        .route("/v1/responses", post(responses_endpoint))
        .layer(axum::extract::DefaultBodyLimit::max(
            (cfg.body_limit_mb * 1024 * 1024).max(1) as usize,
        ))
        .layer(axum::middleware::from_fn_with_state(cors_origins, cors_mw))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[gateway] bind {addr} failed: {e}");
            return;
        }
    };
    eprintln!("[gateway] serving on {addr}");
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
        })
        .await;
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "gateway" }))
}

/// Bearer 鉴权：Authorization: Bearer <api_key>，配置为空时拒绝所有
fn check_auth(state: &SvcState, headers: &HeaderMap) -> Result<(), StatusCode> {
    if state.api_key.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    if got != state.api_key {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

/// /v1/models：静态列表。真实模型面（按登录号 entitlements 生成）M2 接。
async fn models(State(state): State<std::sync::Arc<SvcState>>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    check_auth(&state, &headers)?;
    let model = |id: &str| {
        json!({
            "id": id, "object": "model", "created": 0, "owned_by": "zcode-switch",
            "permission": [], "root": id, "parent": null,
        })
    };
    Ok(Json(json!({
        "object": "list",
        "data": crate::gateway::MODEL_LIST.iter().map(|id| model(id)).collect::<Vec<_>>(),
    })))
}

/// /v1/messages（M4 完整版）：入站 stream=true 时上游 SSE 原样透传（Anthropic 原生客户端
/// 自行解析事件流）；stream=false/缺省时聚合为非流式 message。
async fn messages(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    let body_json: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string()))),
    };
    let model = body_json
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("GLM-5.3-Flash")
        .to_string();
    let stream = body_json.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &body_json);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = match translate::anthropic_to_upstream(&body_json) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e))),
    };
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/messages", &model, stream, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = translate::aggregate_sse(&raw, &model);
        push_ok_log(&state.shared, "/v1/messages", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, stream, &req_id, &req_preview, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }
    // 流式：上游 SSE 原样透传（Anthropic 原生客户端，事件形态一致，零转换）
    let ok = pool_send(&state, &prepared, "/v1/messages", &model, stream, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut resp = resp;
        let mut acc = String::new(); // 下游透传原文累积（截断入日志）
        while let Ok(Some(c)) = resp.chunk().await {
            if acc.chars().count() < LOG_RESP_CAP {
                acc.push_str(&String::from_utf8_lossy(&c));
            }
            if tx.send(Ok(c)).await.is_err() {
                break;
            }
        }
        push_ok_log(
            &shared,
            "/v1/messages", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, stream, &req_id, &req_preview, Some(clip(&acc, LOG_RESP_CAP)),
        );
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

/// /v1/chat/completions（M3）：OpenAI 入站 → anthropic 上游。
/// 非流式：上游 SSE 聚合为 chat.completion；流式：逐块转 chat.completion.chunk。入站一律转 stream=true。
async fn chat_completions(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = req
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("GLM-5.3-Flash")
        .to_string();
    let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &req);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = openai::openai_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/chat/completions", &model, stream, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = openai::aggregate_sse_to_openai(&raw, &model);
        push_ok_log(&state.shared, "/v1/chat/completions", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, stream, &req_id, &req_preview, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }

    let ok = pool_send(&state, &prepared, "/v1/chat/completions", &model, stream, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut conv = openai::OpenAiStream::new(&model);
        let mut resp = resp;
        let mut acc = String::new(); // 下游 chunk 帧累积（截断入日志）
        loop {
            match resp.chunk().await {
                Ok(Some(c)) => {
                    let out = conv.feed(&String::from_utf8_lossy(&c));
                    if acc.chars().count() < LOG_RESP_CAP {
                        acc.push_str(&out);
                    }
                    if !out.is_empty() && tx.send(Ok(bytes::Bytes::from(out))).await.is_err() {
                        break; // 客户端断开
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
            }
        }
        let fin = conv.finish();
        if acc.chars().count() < LOG_RESP_CAP {
            acc.push_str(&fin);
        }
        let _ = tx.send(Ok(bytes::Bytes::from(fin))).await;
        push_ok_log(&shared, "/v1/chat/completions", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, stream, &req_id, &req_preview, Some(clip(&acc, LOG_RESP_CAP)));
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

enum UpstreamReply {
    /// 上游统一走 stream=true，非流式路径由调用侧 bytes().await 聚合
    Stream(reqwest::Response),
}

/// 手写 CORS 中间件（不引 tower-http）：精确匹配 state.cors_origins；含 "*" 放行全部。
/// 空列表 = 不发 CORS 头（本机 CLI 调用不受影响，浏览器端会被同源策略拦）。
/// OPTIONS 预检直接回 204（带对应头），不带鉴权——预检请求按规范不携带凭据。
async fn cors_mw(
    State(origins): State<Vec<String>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let Some(origin) = origin else {
        // 无 Origin 头：非浏览器调用，原样放行
        return next.run(req).await;
    };
    let allow = origins.iter().any(|o| o == "*" || o == &origin);
    if req.method() == axum::http::Method::OPTIONS {
        let mut resp = Response::new(axum::body::Body::empty());
        if allow {
            *resp.status_mut() = StatusCode::NO_CONTENT;
            cors_headers(&mut resp, &origin, true);
        } else {
            *resp.status_mut() = StatusCode::FORBIDDEN;
        }
        return resp;
    }
    let mut resp = next.run(req).await;
    if allow {
        cors_headers(&mut resp, &origin, false);
    }
    resp
}

fn cors_headers(resp: &mut Response, origin: &str, preflight: bool) {
    let h = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    if preflight {
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type, anthropic-version, x-api-key"),
        );
        h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    }
}

/// pool_send 成功后的登记材料：成功日志由 handler 推（响应体聚合完成后才完整）。
/// started 用于 handler 在消费点算总耗时；ttft_ms = 上游响应头到达（流式即首帧）时间
struct UpstreamOk {
    reply: UpstreamReply,
    account: String,
    attempt: usize,
    ttft_ms: u64,
    started: std::time::Instant,
    /// 请求关联 ID：一次客户端请求（含换号重试产生的多条日志）共用
    req_id: String,
}

/// 日志 body 截断：超长按字符裁切并标记，避免单条请求把日志环/落盘撑爆
fn clip(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let head: String = s.chars().take(cap).collect();
    format!("{head}…[截断，共 {} 字符]", s.chars().count())
}

const LOG_REQ_CAP: usize = 8192;
const LOG_RESP_CAP: usize = 16384;

/// 从聚合后的响应文本提取 usage：输入 / 输出 / 缓存读 / 缓存写。
/// 响应文本两种载体：非流式路径存聚合 JSON（顶层 /usage），流式路径存 SSE 全文
/// （anthropic 的 message_start/message_delta，openai/responses 的逐帧 /usage）。
/// 字段名三套别名：anthropic（input_tokens/cache_read_input_tokens/…）、
/// chat（prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens）、
/// responses（input_tokens/output_tokens/input_tokens_details.cached_tokens）。
fn usage_get(u: &Value, k: &str) -> Option<i64> {
    u.get(k).and_then(|x| x.as_i64())
}

fn usage_in(u: &Value) -> Option<i64> {
    usage_get(u, "input_tokens").or_else(|| usage_get(u, "prompt_tokens"))
}

fn usage_out(u: &Value) -> Option<i64> {
    usage_get(u, "output_tokens").or_else(|| usage_get(u, "completion_tokens"))
}

fn usage_cache_read(u: &Value) -> Option<i64> {
    usage_get(u, "cache_read_input_tokens")
        .or_else(|| u.pointer("/input_tokens_details/cached_tokens").and_then(|x| x.as_i64()))
        .or_else(|| u.pointer("/prompt_tokens_details/cached_tokens").and_then(|x| x.as_i64()))
}

fn usage_cache_write(u: &Value) -> Option<i64> {
    usage_get(u, "cache_creation_input_tokens")
}

fn extract_usage(resp: Option<&String>) -> (i64, i64, i64, i64) {
    let Some(raw) = resp else { return (0, 0, 0, 0) };
    let mut tin = 0i64;
    let mut tout = 0i64;
    let mut tcr = 0i64;
    let mut tcw = 0i64;
    // 载体一：整段是聚合 JSON（非流式路径）
    if let Ok(v) = serde_json::from_str::<Value>(raw.trim()) {
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            if let Some(x) = usage_in(u) { tin = x; }
            if let Some(x) = usage_out(u) { tout = x; }
            if let Some(x) = usage_cache_read(u) { tcr = x; }
            if let Some(x) = usage_cache_write(u) { tcw = x; }
            return (tin, tout, tcr, tcw);
        }
    }
    // 载体二：SSE 全文逐行（流式路径）
    for line in raw.lines() {
        let Some(d) = line.strip_prefix("data: ") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(d.trim()) else { continue };
        let Some(u) = v.pointer("/message/usage").or_else(|| v.pointer("/usage")) else { continue };
        if let Some(x) = usage_in(u) { tin = x; }
        if let Some(x) = usage_out(u) { tout = x; }
        if let Some(x) = usage_cache_read(u) { tcr = x; }
        if let Some(x) = usage_cache_write(u) { tcw = x; }
    }
    (tin, tout, tcr, tcw)
}

fn push_ok_log(
    shared: &super::GatewayShared,
    ep: &str,
    account: &str,
    ms: u64,
    ttft_ms: u64,
    attempt: usize,
    model: &str,
    stream: bool,
    req_id: &str,
    req: &str,
    resp: Option<String>,
) {
    let (tin, tout, tcr, tcw) = extract_usage(resp.as_ref());
    shared.push_log(json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "ep": ep, "account": account, "status": 200, "ok": true,
        "model": model, "stream": stream,
        "ms": ms, "ttft": ttft_ms, "attempt": attempt,
        "req_id": req_id,
        "tin": tin, "tout": tout, "tcr": tcr, "tcw": tcw,
        "req": req,
        "resp": resp,
    }));
}
/// pool 分发：选号 → 发上游 → 按错误档收尾。
/// 粘性优先（成功游标不动）；429/3008-3010/网络错误换号重放（重试次数可配）；
/// 3012/405 全局退避（时长可配）；全员不可用 503。members/claim_token 都是阻塞面（文件 IO + 解密），丢 blocking 池。
/// 会话标识提取（LiteLLM session affinity 同思路）：专用头优先，其次 body.metadata。
fn session_of(headers: &HeaderMap, body: &Value) -> Option<String> {
    for h in ["x-session-id", "x-claude-code-session-id", "x-litellm-session-id"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()).filter(|s| !s.is_empty()) {
            return Some(v.to_string());
        }
    }
    body.pointer("/metadata/session_id")
        .or_else(|| body.pointer("/metadata/user_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}


/// pool 分发：选号 → 发上游 → 按错误档收尾。
/// 粘性优先（成功游标不动）；429/3008-3010/网络错误换号重放（重试次数可配）；
/// 3012/405 全局退避（时长可配）；全员不可用 503。members/claim_token 都是阻塞面（文件 IO + 解密），丢 blocking 池。
/// 会话标识提取（LiteLLM session affinity 同思路）：专用头优先，其次 body.metadata。


async fn pool_send(
    state: &SvcState,
    prepared: &[u8],
    ep: &str,
    model: &str,
    stream: bool,
    req_preview: &str,
    req_id: &str,
    sticky: pool::Sticky<'_>,
) -> Result<UpstreamOk, (StatusCode, Json<Value>)> {
    let members = match tokio::task::spawn_blocking(pool::members).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err((StatusCode::SERVICE_UNAVAILABLE, api_error_id("api_error", &e, req_id))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, api_error_id("api_error", &e.to_string(), req_id))),
    };
    if members.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            api_error_id("api_error", "pool: no logged-in account", req_id),
        ));
    }
    // 初始尝试 + max_retries 次换号重放；全部失败即把最后的错误交回客户端
    for attempt in 0..=state.max_retries as usize {
        let Some(idx) = state.shared.pool.pick(&members, sticky) else {
            let wait = state.shared.pool.global_backoff_secs().max(1);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                api_error_id("api_error", &format!("pool unavailable, retry after {wait}s"), req_id),
            ));
        };
        let m = &members[idx];
        let t0 = std::time::Instant::now();
        match upstream::messages_stream(&state.http, &m.token, m.mid.as_deref(), prepared).await {
            Ok(resp) => {
                state.shared.pool.settle(&m.id, idx, members.len(), true, 0, sticky);
                return Ok(UpstreamOk {
                    reply: UpstreamReply::Stream(resp),
                    account: m.name.clone(),
                    // ttft = 上游响应头到达（流式即首帧前导时间）；总耗时由消费点用 started 结算
                    ttft_ms: t0.elapsed().as_millis() as u64,
                    started: t0,
                    attempt,
                    req_id: req_id.to_string(),
                });
            }
            Err(up) => {
                let cd = upstream::cooldown_secs(up.status, &up.body);
                state.shared.pool.settle(&m.id, idx, members.len(), false, cd, sticky);
                // 错误摘要：body 截前 200 字符，展开详情用
                let err_sum: String = up.body.chars().take(200).collect();
                state.shared.push_log(json!({
                    "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    "ep": ep, "account": m.name, "status": up.status, "ok": false,
                    "model": model, "stream": stream,
                    "ms": t0.elapsed().as_millis() as u64,
                    "attempt": attempt,
                    "req_id": req_id,
                    "err": err_sum,
                    "req": req_preview,
                }));
                upstream::note_risk_response(up.status, &up.body);
                if upstream::is_global_risk(up.status, &up.body) {
                    state.shared.pool.global_backoff(state.backoff_secs);
                    return Err((
                        StatusCode::from_u16(up.status).unwrap_or(StatusCode::FORBIDDEN),
                        api_error_id("upstream_error", &up.body, req_id),
                    ));
                }
                if attempt < state.max_retries as usize && upstream::is_retryable(up.status, &up.body) {
                    continue;
                }
                return Err((
                    StatusCode::from_u16(up.status).unwrap_or(StatusCode::BAD_GATEWAY),
                    api_error_id("upstream_error", &up.body, req_id),
                ));
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn api_error(typ: &str, msg: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg } }))
}

/// 带 req_id 的错误响应：客户端报错时引用此 ID 即可对到日志
fn api_error_id(typ: &str, msg: &str, req_id: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg, "req_id": req_id } }))
}

/// /v1/responses（M4/M5）：OpenAI Responses 入站 → anthropic 上游。
/// 非流式：上游 SSE 聚合为 response 对象；流式：装配 Responses 事件流
/// （created → output_text.delta / function_call → output_item.done → completed）。
async fn responses_endpoint(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    // 请求关联 ID：换号重试产生的多条日志共用；错误响应体回传供客户端对账
    let req_id = uuid::Uuid::new_v4().simple().to_string();
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = super::translate::map_model(get_str_req(&req, "model"));
    let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let session = session_of(&headers, &req);
    let sticky = session.as_deref().map_or(pool::Sticky::None, pool::Sticky::Session);
    let prepared = super::responses::responses_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let req_preview = clip(&String::from_utf8_lossy(&body), LOG_REQ_CAP);
    if !stream {
        let ok = pool_send(&state, &prepared, "/v1/responses", &model, false, &req_preview, &req_id, sticky).await?;
        let bytes = match ok.reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let out = super::responses::aggregate_sse_to_responses(&raw, &model);
        push_ok_log(&state.shared, "/v1/responses", &ok.account, ok.started.elapsed().as_millis() as u64, ok.ttft_ms, ok.attempt, &model, false, &req_id, &req_preview, Some(clip(&out.to_string(), LOG_RESP_CAP)));
        return Ok(Json(out).into_response());
    }
    let ok = pool_send(&state, &prepared, "/v1/responses", &model, true, &req_preview, &req_id, sticky).await?;
    let UpstreamOk { reply, account, attempt, ttft_ms, started, req_id } = ok;
    let resp = match reply {
        UpstreamReply::Stream(r) => r,
    };
    let shared = std::sync::Arc::clone(&state.shared);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut stream = super::responses::ResponsesStream::new(&model);
        let mut resp = resp;
        let pre = stream.take_pending();
        let mut acc = pre.clone(); // 下游帧累积（截断入日志）
        if tx.send(Ok(bytes::Bytes::from(pre))).await.is_err() {
            return; // 客户端断开
        }
        loop {
            match resp.chunk().await {
                Ok(Some(c)) => {
                    let out = stream.feed(&String::from_utf8_lossy(&c));
                    if acc.chars().count() < LOG_RESP_CAP {
                        acc.push_str(&out);
                    }
                    if !out.is_empty() && tx.send(Ok(bytes::Bytes::from(out))).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    return;
                }
            }
        }
        let fin = stream.finish();
        if acc.chars().count() < LOG_RESP_CAP {
            acc.push_str(&fin);
        }
        let _ = tx.send(Ok(bytes::Bytes::from(fin))).await;
        push_ok_log(&shared, "/v1/responses", &account, started.elapsed().as_millis() as u64, ttft_ms, attempt, &model, true, &req_id, &req_preview, Some(clip(&acc, LOG_RESP_CAP)));
    });
    let mut resp = Response::new(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    Ok(resp)
}

fn get_str_req<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
