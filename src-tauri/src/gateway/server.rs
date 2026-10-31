// GATEWAY HTTP 服务：axum 路由 + Bearer 鉴权 + health + /v1/models 静态列表
// M2-M3：/v1/messages 直通聚合；/v1/chat/completions OpenAI 转换（非流式聚合 + SSE 流式）。
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::{pool, translate, upstream};

struct SvcState {
    api_key: String,
    http: reqwest::Client,
    farm: pool::Farm,
}

pub async fn serve(addr: std::net::SocketAddr, api_key: String, mut shutdown: watch::Receiver<bool>) {
    let state = std::sync::Arc::new(SvcState {
        api_key,
        http: reqwest::Client::new(),
        farm: pool::Farm::new(),
    });
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/messages", post(messages))
        .route("/v1/responses", post(responses_endpoint))
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
        "data": [model("GLM-5.3"), model("GLM-5.3-Flash"), model("glm-5.3-flash")],
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
    let prepared = match translate::anthropic_to_upstream(&body_json) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e))),
    };
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    if !stream {
        let reply = farm_send(&state, &prepared).await?;
        let bytes = match reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(Json(translate::aggregate_sse(&raw, &model)).into_response());
    }
    // 流式：上游 SSE 原样透传（Anthropic 原生客户端，事件形态一致，零转换）
    let resp = match farm_send(&state, &prepared).await? {
        UpstreamReply::Stream(r) => r,
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut resp = resp;
        while let Ok(Some(c)) = resp.chunk().await {
            if tx.send(Ok(c)).await.is_err() {
                break;
            }
        }
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
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = req
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("GLM-5.3-Flash")
        .to_string();
    let stream = req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let prepared = translate::openai_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    if !stream {
        let reply = farm_send(&state, &prepared).await?;
        let bytes = match reply {
            UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
                (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
            })?,
        };
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(Json(translate::aggregate_sse_to_openai(&raw, &model)).into_response());
    }

    let resp = match farm_send(&state, &prepared).await? {
        UpstreamReply::Stream(r) => r,
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    tokio::spawn(async move {
        let mut chunker = translate::OpenAiChunker::new(&model);
        let mut resp = resp;
        loop {
            match resp.chunk().await {
                Ok(Some(c)) => {
                    let out = chunker.feed(&String::from_utf8_lossy(&c));
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
        let fin = chunker.finish();
        let _ = tx.send(Ok(bytes::Bytes::from(fin))).await;
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

/// 农场分发：选号 → 发上游 → 按错误档收尾。
/// 粘性优先（成功游标不动）；429/3008-3010/网络错误换号重放一轮；3012/405 全局退避 10min；
/// 全员不可用 503。farm_members/claim_token 都是阻塞面（文件 IO + 解密），丢 blocking 池。
async fn farm_send(
    state: &SvcState,
    prepared: &[u8],
) -> Result<UpstreamReply, (StatusCode, Json<Value>)> {
    let members = match tokio::task::spawn_blocking(pool::farm_members).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => return Err((StatusCode::SERVICE_UNAVAILABLE, api_error("api_error", &e))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))),
    };
    if members.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            api_error("api_error", "farm: no logged-in account"),
        ));
    }
    // 初始尝试 + 1 次换号重放；两次都失败即把最后的错误交回客户端
    for attempt in 0..2 {
        let Some(idx) = state.farm.pick(&members) else {
            let wait = state.farm.global_backoff_secs().max(1);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                api_error("api_error", &format!("farm unavailable, retry after {wait}s")),
            ));
        };
        let m = &members[idx];
        match upstream::messages_stream(&state.http, &m.token, m.mid.as_deref(), prepared).await {
            Ok(resp) => {
                state.farm.settle(&m.id, idx, members.len(), true, 0);
                return Ok(UpstreamReply::Stream(resp));
            }
            Err(up) => {
                let cd = upstream::cooldown_secs(up.status, &up.body);
                state.farm.settle(&m.id, idx, members.len(), false, cd);
                if upstream::is_global_risk(up.status, &up.body) {
                    state.farm.global_backoff(pool::GLOBAL_BACKOFF_SECS);
                    return Err((
                        StatusCode::from_u16(up.status).unwrap_or(StatusCode::FORBIDDEN),
                        api_error("upstream_error", &up.body),
                    ));
                }
                if attempt == 0 && upstream::is_retryable(up.status, &up.body) {
                    continue;
                }
                return Err((
                    StatusCode::from_u16(up.status).unwrap_or(StatusCode::BAD_GATEWAY),
                    api_error("upstream_error", &up.body),
                ));
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn api_error(typ: &str, msg: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg } }))
}

/// /v1/responses（M4）：OpenAI Responses 入站 → anthropic 上游 → 非流式聚合 response 对象。
/// 流式 SSE 透传在 M5 随日志/池可视化一起接（Go 版 streamResponses 同构）。
async fn responses_endpoint(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if let Err(code) = check_auth(&state, &headers) {
        return Err((code, api_error("authentication_error", "invalid api key")));
    }
    let req: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e.to_string())))?;
    let model = super::translate::map_model(get_str_req(&req, "model"));
    let prepared = super::responses::responses_to_upstream(&req)
        .map_err(|e| (StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e)))?;
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    let reply = farm_send(&state, &prepared).await?;
    let bytes = match reply {
        UpstreamReply::Stream(resp) => resp.bytes().await.map_err(|e| {
            (StatusCode::BAD_GATEWAY, api_error("api_error", &e.to_string()))
        })?,
    };
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let agg = translate::aggregate_sse_to_anthropic(&raw, &model);
    let text = agg
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|b| b.get("text"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let input = agg.pointer("/usage/input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let output = agg.pointer("/usage/output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let id = format!("resp_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]);
    Ok(Json(super::responses::responses_object(&id, &model, &text, "completed", input, output)))
}

fn get_str_req<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
