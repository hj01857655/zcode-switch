// TWOAPI 翻译层：OpenAI chat/completions ⇄ Anthropic messages（M3）
// 语义逐条对齐 ZCode2api-go translate.go：system=前缀+追加段（无 cache_control）、
// thinking 走 output_config.effort、上游一律 stream=true、metadata.user_id 内嵌 JSON 串。
use serde_json::{json, Value};

use super::translate::{map_model, prefix_segs};

/// 入站 OpenAI 消息的宽松视图（content 兼容 string 与块数组）
fn flatten_text(content: &Value) -> Vec<String> {
    match content {
        Value::String(s) if !s.is_empty() => vec![s.clone()],
        Value::Array(arr) => arr
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    p.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect(),
        _ => vec![],
    }
}

/// tool arguments 宽松解析（无效 JSON 包成 {"_raw": 原文}）
fn safe_json(raw: &Value) -> Value {
    if raw.is_null() {
        return json!({});
    }
    if raw.is_object() {
        return raw.clone();
    }
    if let Some(s) = raw.as_str() {
        if let Ok(m) = serde_json::from_str::<Value>(s) {
            if m.is_object() {
                return m;
            }
        }
        return json!({ "_raw": s });
    }
    json!({ "_raw": raw.to_string() })
}

/// data:image URI → anthropic base64 image 块；非 data URI 返回 None
fn data_image(url: &str) -> Option<Value> {
    let rest = url.strip_prefix("data:image/")?;
    let (meta, b64) = rest.split_once(',')?;
    let media = meta.split(';').next().unwrap_or("png");
    Some(json!({
        "type": "image",
        "source": { "type": "base64", "media_type": format!("image/{media}"), "data": b64 },
    }))
}

/// OpenAI tool_choice → Anthropic tool_choice；"none"/不可映射返回 None（不发）
fn map_tool_choice(raw: Option<&Value>) -> Option<Value> {
    match raw? {
        Value::String(s) => match s.to_lowercase().trim() {
            "auto" => Some(json!({ "type": "auto" })),
            "required" | "any" => Some(json!({ "type": "any" })),
            _ => None, // "none" 不发：上游收到会空响应
        },
        Value::Object(o) => {
            let name = o
                .get("function")
                .and_then(|f| f.get("name"))
                .or_else(|| o.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            if name.is_empty() {
                None
            } else {
                Some(json!({ "type": "tool", "name": name }))
            }
        }
        _ => None,
    }
}

/// anthropic stop_reason → OpenAI finish_reason；空/未知一律 stop
pub fn map_stop(reason: &str) -> &'static str {
    match reason {
        "tool_use" => "tool_calls",
        "max_tokens" => "length",
        _ => "stop", // end_turn / stop_sequence / 未知
    }
}

/// OpenAI chat/completions 请求 → anthropic 上游 body
pub fn openai_to_upstream(req: &Value) -> Result<Value, String> {
    if !req.get("messages").map(|m| m.is_array()).unwrap_or(false) {
        return Err("messages array required".into());
    }

    let mut sys_extra: Vec<String> = vec![];
    let mut msgs: Vec<Value> = vec![];

    for m in req.get("messages").and_then(|m| m.as_array()).unwrap() {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = m.get("content").unwrap_or(&Value::Null);
        match role {
            "system" | "developer" => {
                sys_extra.extend(flatten_text(content));
            }
            "tool" => {
                // OpenAI tool 结果 → anthropic user/tool_result 块
                msgs.push(json!({
                    "role": "user",
                    "content": [{ "type": "tool_result",
                        "tool_use_id": m.get("tool_call_id").cloned().unwrap_or(Value::Null),
                        "content": flatten_text(content).join("\n") }],
                }));
            }
            "assistant" => {
                // 消息级 tool_calls 形状
                let tool_calls = m.get("tool_calls").and_then(|t| t.as_array());
                if let Some(tcs) = tool_calls.filter(|t| !t.is_empty()) {
                    let mut parts: Vec<Value> = flatten_text(content)
                        .into_iter()
                        .map(|t| json!({ "type": "text", "text": t }))
                        .collect();
                    for tc in tcs {
                        let id = tc
                            .get("id")
                            .and_then(|x| x.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
                        let f = tc.get("function").cloned().unwrap_or(json!({}));
                        parts.push(json!({
                            "type": "tool_use", "id": id,
                            "name": f.get("name").cloned().unwrap_or(Value::Null),
                            "input": safe_json(f.get("arguments").unwrap_or(&Value::Null)),
                        }));
                    }
                    msgs.push(json!({ "role": "assistant", "content": parts }));
                    continue;
                }
                // 兼容 content 数组内联 function 块形状
                let mut handled = false;
                if let Value::Array(arr) = content {
                    let mut parts: Vec<Value> = vec![];
                    for p in arr {
                        match p.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = p.get("text").and_then(|x| x.as_str()) {
                                    if !t.is_empty() {
                                        parts.push(json!({ "type": "text", "text": t }));
                                    }
                                }
                            }
                            Some("function") => {
                                let id = p
                                    .get("id")
                                    .and_then(|x| x.as_str())
                                    .filter(|s| !s.is_empty())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
                                parts.push(json!({
                                    "type": "tool_use", "id": id,
                                    "name": p.get("name").cloned().unwrap_or(Value::Null),
                                    "input": safe_json(p.get("arguments").unwrap_or(&Value::Null)),
                                }));
                            }
                            _ => {}
                        }
                    }
                    if !parts.is_empty() {
                        msgs.push(json!({ "role": "assistant", "content": parts }));
                        handled = true;
                    }
                }
                if !handled {
                    msgs.push(json!({ "role": "assistant", "content": flatten_text(content).join("\n") }));
                }
            }
            _ => {
                // user：支持视觉输入（data:image → base64 块）
                if let Value::Array(arr) = content {
                    let mut parts: Vec<Value> = vec![];
                    for p in arr {
                        match p.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = p.get("text").and_then(|x| x.as_str()) {
                                    if !t.is_empty() {
                                        parts.push(json!({ "type": "text", "text": t }));
                                    }
                                }
                            }
                            Some("image_url") => {
                                if let Some(url) = p.pointer("/image_url/url").and_then(|x| x.as_str()) {
                                    if let Some(img) = data_image(url) {
                                        parts.push(img);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    if parts.is_empty() {
                        parts.push(json!({ "type": "text", "text": "" }));
                    }
                    msgs.push(json!({ "role": "user", "content": parts }));
                } else {
                    msgs.push(json!({ "role": "user", "content": flatten_text(content).join("\n") }));
                }
            }
        }
    }

    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n") }));
    }

    let max_tokens = match req.get("max_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };

    // thinking：OpenAI 侧扩展字段 "enabled"/"disabled"（Go 版本网关扩展）
    let effort = match req.get("thinking").and_then(|v| v.as_str()) {
        Some("enabled") => "high",
        Some(s) if s == "low" || s == "high" || s == "max" => s,
        _ => "",
    };

    // metadata.user_id 内嵌 JSON 字符串（形状照发，风控不校验）
    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    })
    .to_string();

    let mut out = json!({
        "model": map_model(req.get("model").and_then(|m| m.as_str()).unwrap_or("")),
        "messages": msgs,
        "max_tokens": max_tokens,
        "stream": true, // 上游一律流式；非流式由 handler 聚合
        "system": system,
        "metadata": { "user_id": uid },
    });
    if !effort.is_empty() {
        out["output_config"] = json!({ "effort": effort });
    }
    if let Some(t) = req.get("temperature").filter(|v| v.is_number()) {
        out["temperature"] = t.clone();
    }
    if let Some(p) = req.get("top_p").filter(|v| v.is_number()) {
        out["top_p"] = p.clone();
    }
    // stop：兼容 string 与 array 两种形状
    match req.get("stop") {
        Some(Value::String(s)) if !s.is_empty() => out["stop_sequences"] = json!([s]),
        Some(Value::Array(a)) if !a.is_empty() => out["stop_sequences"] = json!(a),
        _ => {}
    }
    // tools：OpenAI function 形状 → anthropic input_schema
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()).filter(|t| !t.is_empty()) {
        let conv: Vec<Value> = tools
            .iter()
            .map(|t| {
                let f = t.get("function").cloned().unwrap_or(json!({}));
                let params = f
                    .get("parameters")
                    .filter(|p| p.is_object())
                    .cloned()
                    .unwrap_or(json!({ "type": "object" }));
                json!({
                    "name": f.get("name").cloned().unwrap_or(Value::Null),
                    "description": f.get("description").cloned().unwrap_or(Value::Null),
                    "input_schema": params,
                })
            })
            .collect();
        out["tools"] = json!(conv);
    }
    if let Some(tc) = map_tool_choice(req.get("tool_choice")) {
        out["tool_choice"] = tc;
    }
    Ok(out)
}

// ---------- 上游 SSE → OpenAI 出站 ----------

/// 一次下游转发的动作（Go translate.go Delta 语义）
pub enum Delta {
    Role,
    Content(String),
    Reason(String),
    ToolStart { index: usize, id: String, name: String },
    ToolArgs { index: usize, args: String },
    Finish(String),
    /// message_delta 同时携带 finish 与 output usage
    FinishUsage { finish: String, output: i64 },
    Usage { input: i64, output: i64 },
    Error(String),
}

/// 解析一行上游 SSE data 负载 → 转发动作；无关事件返回 None
pub fn translate_sse_line(payload: &str) -> Option<Delta> {
    if payload.is_empty() || payload == "[DONE]" {
        return None;
    }
    let ev: Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return Some(Delta::Error(payload.to_string())), // 非 JSON 原样透传
    };
    match ev.get("type").and_then(|t| t.as_str()) {
        Some("message_start") => {
            let input = ev
                .pointer("/message/usage/input_tokens")
                .and_then(|x| x.as_i64())
                .unwrap_or(0);
            Some(Delta::Usage { input, output: 0 })
        }
        Some("content_block_start") => {
            let block = ev.get("content_block")?;
            if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                Some(Delta::ToolStart {
                    index: ev.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize,
                    id: block.get("id").and_then(|x| x.as_str()).unwrap_or("").into(),
                    name: block.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
                })
            } else {
                None
            }
        }
        Some("content_block_delta") => {
            let delta = ev.get("delta")?;
            let index = ev.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
            match delta.get("type").and_then(|t| t.as_str()) {
                Some("text_delta") => delta.get("text").and_then(|x| x.as_str()).map(|s| Delta::Content(s.into())),
                Some("thinking_delta") => delta.get("thinking").and_then(|x| x.as_str()).map(|s| Delta::Reason(s.into())),
                Some("input_json_delta") => delta
                    .get("partial_json")
                    .and_then(|x| x.as_str())
                    .map(|s| Delta::ToolArgs { index, args: s.into() }),
                _ => None,
            }
        }
        Some("message_delta") => {
            let finish = ev
                .pointer("/delta/stop_reason")
                .and_then(|x| x.as_str())
                .map(map_stop)
                .unwrap_or("stop")
                .to_string();
            let output = ev.pointer("/usage/output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
            Some(Delta::FinishUsage { finish, output })
        }
        Some("error") => Some(Delta::Error(
            ev.pointer("/error/message")
                .and_then(|x| x.as_str())
                .unwrap_or("upstream error")
                .into(),
        )),
        _ => None,
    }
}

/// 非流式聚合结果 → OpenAI chat.completion 帧
pub fn completion_frame(id: &str, model: &str, text: &str, reasoning: &str, finish: &str, input: i64, output: i64) -> Value {
    let mut message = json!({ "role": "assistant", "content": text });
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    json!({
        "id": id, "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(), "model": model,
        "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
        "usage": { "prompt_tokens": input, "completion_tokens": output, "total_tokens": input + output },
    })
}

/// 流式 chunk 帧（每帧新 id 由调用方生成）
pub fn chunk_frame(id: &str, model: &str, delta: Value, finish: Option<&str>) -> String {
    let v = json!({
        "id": id, "object": "chat.completion.chunk",
        "created": chrono::Utc::now().timestamp(), "model": model,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
    });
    format!("data: {v}\n\n")
}

pub fn sse_done() -> &'static str {
    "data: [DONE]\n\n"
}
