// TWOAPI HTTP 服务：axum 路由 + Bearer 鉴权 + health + /v1/models 静态列表
// M1 范围：能起能停能鉴权；chat/responses/messages 转换器 M2-M4 接入。
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use axum::routing::{get, post};
use serde_json::{json, Value};
use tokio::sync::watch;

struct SvcState {
    api_key: String,
}

pub async fn serve(addr: std::net::SocketAddr, api_key: String, mut shutdown: watch::Receiver<bool>) {
    let state = std::sync::Arc::new(SvcState { api_key });
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(not_implemented))
        .route("/v1/messages", post(not_implemented))
        .route("/v1/responses", post(not_implemented))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[twoapi] bind {addr} failed: {e}");
            return;
        }
    };
    eprintln!("[twoapi] serving on {addr}");
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
        })
        .await;
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "twoapi" }))
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

async fn not_implemented() -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": { "message": "chat/responses/messages converters land in M2-M4", "type": "not_implemented" }
        })),
    )
}
