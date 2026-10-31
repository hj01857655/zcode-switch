// GATEWAY HTTP 服务：axum 路由 + Bearer 鉴权 + health + /v1/models 静态列表
// M1 范围：能起能停能鉴权；chat/responses/messages 转换器 M2-M4 接入。
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use axum::routing::{get, post};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::{translate, upstream};

struct SvcState {
    api_key: String,
    http: reqwest::Client,
}

pub async fn serve(addr: std::net::SocketAddr, api_key: String, mut shutdown: watch::Receiver<bool>) {
    let state = std::sync::Arc::new(SvcState {
        api_key,
        http: reqwest::Client::new(),
    });
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(not_implemented))
        .route("/v1/messages", post(messages))
        .route("/v1/responses", post(not_implemented))
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

/// /v1/messages 直通（M2）：前缀注入 → 上游（一律 stream=true）→ 聚合为非流式 message
async fn messages(
    State(state): State<std::sync::Arc<SvcState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
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
    let prepared = match translate::anthropic_to_upstream(&body_json) {
        Ok(v) => v,
        Err(e) => return Err((StatusCode::BAD_REQUEST, api_error("invalid_request_error", &e))),
    };
    let prepared = serde_json::to_vec(&prepared).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))
    })?;
    // claim_token 可能触发凭据刷新（阻塞 ureq），丢 blocking 池
    let token = match tokio::task::spawn_blocking(live_token).await {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return Err((StatusCode::SERVICE_UNAVAILABLE, api_error("api_error", &e))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, api_error("api_error", &e.to_string()))),
    };
    match upstream::messages(&state.http, &token, &prepared).await {
        Ok(bytes) => {
            let raw = String::from_utf8_lossy(&bytes).into_owned();
            Ok(Json(translate::aggregate_sse(&raw, &model)))
        }
        Err(up) => Err((
            StatusCode::from_u16(up.status).unwrap_or(StatusCode::BAD_GATEWAY),
            api_error("upstream_error", &up.body),
        )),
    }
}

fn api_error(typ: &str, msg: &str) -> Json<Value> {
    Json(json!({ "error": { "type": typ, "message": msg } }))
}

/// 当前活跃号的 JWT（enc 解密；与切号/领取共用一份真源）
fn live_token() -> Result<String, String> {
    let paths = crate::Paths::detect();
    let creds = crate::store::read_live(&paths)?.ok_or("no active account")?;
    if !crate::store::is_logged_in(&creds) {
        return Err("active account not logged in".into());
    }
    let secret = crate::zcrypto::default_secret(&paths.home);
    crate::claim::claim_token(&creds, crate::store::read_live_config(&paths).as_ref(), &secret)
}

async fn not_implemented() -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": { "message": "chat/responses/messages converters land in M2-M4", "type": "not_implemented" }
        })),
    )
}
