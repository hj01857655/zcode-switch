// TWOAPI 翻译层：OpenAI Responses API ⇄ Anthropic messages（M4）
// 语义对齐 ZCode2api-go internal/server/responses.go：instructions/text.format→system 追加段、
// input 字符串或 item 数组（function_call/function_call_output 双向）、tools 内置类型跳过。
use serde_json::{json, Value};

use super::translate::{map_model, prefix_segs};

/// Responses 入站请求的宽松视图
fn get_str<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(|x| x.as_str())
}

/// Responses content 块数组 → 纯文本（兼容 string）
fn flatten_content(raw: Option<&Value>) -> String {
    match raw {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Responses 请求 → anthropic 上游 body
pub fn responses_to_upstream(req: &Value) -> Result<Value, String> {
    let mut sys_extra: Vec<String> = vec![];
    if let Some(ins) = get_str(req, "instructions").map(str::trim).filter(|s| !s.is_empty()) {
        sys_extra.push(ins.to_string());
    }
    // text.format → 提示词约束（Anthropic 上游无原生 structured output）
    if let Some(fmt) = req.pointer("/text/format") {
        match get_str(fmt, "type") {
            Some("json_schema") => {
                let mut hint = "必须只输出符合以下 JSON Schema 的 JSON 对象，不要输出任何解释、markdown 代码块或多余文字：\n".to_string();
                if let Some(schema) = fmt.get("schema") {
                    hint += &schema.to_string();
                }
                sys_extra.push(hint);
            }
            Some("json_object") => sys_extra.push("必须只输出一个 JSON 对象，不要输出任何解释或 markdown 代码块。".into()),
            _ => {}
        }
    }

    let mut msgs: Vec<Value> = vec![];
    match req.get("input") {
        // 字符串：单条 user
        Some(Value::String(s)) if !s.trim().is_empty() => {
            msgs.push(json!({ "role": "user", "content": s }));
        }
        Some(Value::Array(items)) => {
            for it in items {
                let it_type = get_str(it, "type").unwrap_or("");
                let role = get_str(it, "role").unwrap_or("user");
                match it_type {
                    // assistant 侧发起的工具调用 → tool_use 块
                    "function_call" => {
                        let input = match get_str(it, "arguments") {
                            Some(a) if !a.is_empty() => serde_json::from_str::<Value>(a)
                                .unwrap_or_else(|_| json!({ "_raw": a })),
                            _ => json!({}),
                        };
                        let id = get_str(it, "call_id")
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("call_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
                        msgs.push(json!({
                            "role": "assistant",
                            "content": [{ "type": "tool_use", "id": id,
                                "name": get_str(it, "name").unwrap_or(""), "input": input }],
                        }));
                        continue;
                    }
                    // 客户端回传的工具结果 → user tool_result 块
                    "function_call_output" => {
                        let out_text = flatten_content(it.get("output"));
                        let out_text = if out_text.is_empty() {
                            it.get("output").map(|v| v.to_string()).unwrap_or_default()
                        } else {
                            out_text
                        };
                        msgs.push(json!({
                            "role": "user",
                            "content": [{ "type": "tool_result",
                                "tool_use_id": get_str(it, "call_id").unwrap_or(""), "content": out_text }],
                        }));
                        continue;
                    }
                    _ => {}
                }
                let text = flatten_content(it.get("content"));
                match role {
                    "system" | "developer" => {
                        if !text.is_empty() {
                            sys_extra.push(text);
                        }
                    }
                    "assistant" => {
                        if !text.is_empty() {
                            msgs.push(json!({ "role": "assistant", "content": text }));
                        }
                    }
                    _ => {
                        if !text.is_empty() {
                            msgs.push(json!({ "role": "user", "content": text }));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    if msgs.is_empty() {
        msgs.push(json!({ "role": "user", "content": "" }));
    }

    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n") }));
    }

    let max_tokens = match req.get("max_output_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };
    let effort = req
        .pointer("/reasoning/effort")
        .and_then(|x| x.as_str())
        .filter(|e| matches!(*e, "low" | "high" | "max"))
        .unwrap_or("");

    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    })
    .to_string();

    let mut out = json!({
        "model": map_model(get_str(req, "model").unwrap_or("")),
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
    // tools：Responses 的 {type:"function",name,description,parameters} → anthropic；
    // 内置工具（web_search 等）上游不支持，跳过
    if let Some(tools) = req.get("tools").and_then(|v| v.as_array()).filter(|t| !t.is_empty()) {
        let conv: Vec<Value> = tools
            .iter()
            .filter_map(|t| {
                let typ = get_str(t, "type").unwrap_or("");
                if !typ.is_empty() && typ != "function" {
                    return None;
                }
                let mut name = get_str(t, "name").unwrap_or("").to_string();
                let mut desc = get_str(t, "description").unwrap_or("").to_string();
                let mut params = t.get("parameters").cloned();
                if name.is_empty() {
                    if let Some(f) = t.get("function") {
                        name = get_str(f, "name").unwrap_or("").to_string();
                        desc = get_str(f, "description").unwrap_or("").to_string();
                        params = f.get("parameters").cloned();
                    }
                }
                if name.is_empty() {
                    return None;
                }
                let params = params.unwrap_or(json!({ "type": "object", "properties": {} }));
                Some(json!({ "name": name, "description": desc, "input_schema": params }))
            })
            .collect();
        if !conv.is_empty() {
            out["tools"] = json!(conv);
        }
    }
    // tool_choice 复用 chat 层映射
    if let Some(tc) = super::openai::map_tool_choice_pub(req.get("tool_choice")) {
        out["tool_choice"] = tc;
    }
    Ok(out)
}

/// 非流式聚合 → Responses response 对象
pub fn responses_object(id: &str, model: &str, text: &str, status: &str, input: i64, output: i64) -> Value {
    let mut content: Vec<Value> = vec![];
    if !text.is_empty() {
        content.push(json!({ "type": "output_text", "text": text, "annotations": [] }));
    }
    let output_arr = if !text.is_empty() {
        json!([{ "id": format!("msg_{}", &uuid::Uuid::new_v4().simple().to_string()[..24]),
                 "type": "message", "status": status, "role": "assistant", "content": content }])
    } else {
        json!([])
    };
    json!({
        "id": id,
        "object": "response",
        "created_at": chrono::Utc::now().timestamp(),
        "status": status,
        "model": model,
        "output": output_arr,
        "usage": {
            "input_tokens": input, "output_tokens": output, "total_tokens": input + output,
            "input_tokens_details": { "cached_tokens": 0 },
            "output_tokens_details": { "reasoning_tokens": 0 },
        },
    })
}
