// GATEWAY 翻译层：/v1/messages（Anthropic 原生）直通转换器
// 语义对齐 ZCode2api-go translate.go：system = 白名单前缀 + 用户追加段（逐块 cache_control ephemeral）、
// max_tokens 钳制、metadata.user_id 形状照发、output_config.effort 思考档。
// M2 范围：messages 入站（原生形态）；OpenAI chat/responses 转换器 M3/M4 接入。
use serde_json::{json, Value};

/// 前缀快照（3.17.1，构建期嵌入）
pub const PREFIX_JSON: &str = include_str!("assets/prefix.json");

pub fn prefix_segs() -> Vec<String> {
    let v: Value = serde_json::from_str(PREFIX_JSON).expect("prefix.json 损坏");
    v.get("system_prefix")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 模型名映射：表内命中用映射值，否则回落 GLM-5.3-Flash
pub fn map_model(name: &str) -> String {
    match name.trim().to_lowercase().as_str() {
        "glm-5.3" => "GLM-5.3".into(),
        "glm-5.3-flash" => "GLM-5.3-Flash".into(),
        "glm-4.7" => "GLM-4.7".into(),
        _ => "GLM-5.3-Flash".into(),
    }
}

/// /v1/messages 入站（Anthropic 原生）→ 上游 body。
/// 直通为主：model 映射、system 前缀注入、max_tokens 钳制、metadata 补齐、
/// thinking → output_config.effort。非流式请求也转 stream=true（M2 聚合）。
pub fn anthropic_to_upstream(req: &Value) -> Result<Value, String> {
    if !req.get("messages").map(|m| m.is_array()).unwrap_or(false) {
        return Err("messages array required".into());
    }

    // system：入站可为 string 或 text 块数组；抽出用户段，前缀统一注入
    let mut sys_extra: Vec<String> = vec![];
    match req.get("system") {
        Some(Value::String(s)) if !s.is_empty() => sys_extra.push(s.clone()),
        Some(Value::Array(arr)) => {
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            sys_extra.push(t.to_string());
                        }
                    }
                }
            }
        }
        _ => {}
    }

    // 官方 body 逐个 system 块都带 cache_control ephemeral（plan-08 §4），形状照发
    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t, "cache_control": { "type": "ephemeral" } }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n"), "cache_control": { "type": "ephemeral" } }));
    }

    // max_tokens：缺省 4096，上限 128000
    let max_tokens = match req.get("max_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };

    // thinking → output_config.effort（官方路径；disabled 语义 = 不传）
    let effort = req
        .get("thinking")
        .map(|t| {
            // Anthropic 原生形态 {"type":"enabled","budget_tokens":N} → 按预算粗分档
            match (t.get("type").and_then(|x| x.as_str()), t.get("budget_tokens").and_then(|x| x.as_u64())) {
                (Some("enabled"), Some(b)) if b >= 16_000 => "max",
                (Some("enabled"), _) => "high",
                _ => "",
            }
        })
        .unwrap_or("");

    // metadata.user_id 是内嵌 JSON 字符串（形状照发，风控不校验；Go translate.go 对齐）
    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    }).to_string();
    let mut out = json!({
        "model": map_model(req.get("model").and_then(|m| m.as_str()).unwrap_or("")),
        "messages": req.get("messages"),
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
    if let Some(stops) = req.get("stop_sequences").filter(|v| v.is_array()) {
        out["stop_sequences"] = stops.clone();
    }
    // tools / tool_choice 原样透传（上游同为 anthropic 形态）
    if let Some(tools) = req.get("tools").filter(|v| v.is_array() && !v.as_array().unwrap().is_empty()) {
        out["tools"] = tools.clone();
    }
    if let Some(tc) = req.get("tool_choice") {
        if tc.is_object() || tc.as_str() == Some("auto") || tc.as_str() == Some("any") {
            out["tool_choice"] = tc.clone();
        }
        // "none" 不发：上游收到会空响应（Go 版实测）
    }
    Ok(out)
}

/// 从上游 SSE 全文聚合出非流式响应（M2：收到 message_stop / 上游断开即止）。
/// 事件形态：event: content_block_delta / data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
pub fn aggregate_sse(raw: &str, model: &str) -> Value {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut stop_reason: Option<String> = None;
    let mut usage_in: i64 = 0;
    let mut usage_out: i64 = 0;
    let mut id = String::new();

    for line in raw.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(d) => d.trim(),
            None => continue,
        };
        let ev: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match ev.get("type").and_then(|t| t.as_str()) {
            Some("message_start") => {
                id = ev
                    .pointer("/message/id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                usage_in = ev
                    .pointer("/message/usage/input_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
            }
            Some("content_block_delta") => {
                let dt = ev.pointer("/delta/type").and_then(|x| x.as_str()).unwrap_or("");
                if dt == "text_delta" {
                    if let Some(t) = ev.pointer("/delta/text").and_then(|x| x.as_str()) {
                        text.push_str(t);
                    }
                } else if dt == "thinking_delta" {
                    // 上游默认（无 output_config）也带思考块；max_tokens 吃满时 text 可能空
                    if let Some(t) = ev.pointer("/delta/thinking").and_then(|x| x.as_str()) {
                        thinking.push_str(t);
                    }
                }
            }
            Some("message_delta") => {
                stop_reason = ev
                    .pointer("/delta/stop_reason")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string());
                if let Some(u) = ev.pointer("/usage/output_tokens").and_then(|x| x.as_i64()) {
                    usage_out = u;
                }
            }
            Some("message_stop") => break,
            _ => {}
        }
    }

    json!({
        "id": if id.is_empty() { format!("msg_{}", uuid::Uuid::new_v4().simple()) } else { id },
        "type": "message",
        "role": "assistant",
        "model": model,
        // max_tokens 被思考耗尽时 text 为空，回退给出思考预览（附说明），避免消费端拿到空消息
        "content": if text.is_empty() && !thinking.is_empty() {
            json!([{ "type": "text", "text": format!("[思考耗尽 max_tokens] {}", &thinking.chars().take(400).collect::<String>()) }])
        } else {
            json!([{ "type": "text", "text": text }])
        },
        "stop_reason": stop_reason.unwrap_or_else(|| "end_turn".into()),
        "stop_sequence": Value::Null,
        "usage": { "input_tokens": usage_in, "output_tokens": usage_out },
    })
}

/// OpenAI chat/completions 入站 → 上游 anthropic body（M3）。
/// system/developer → system 前缀段；content 数组只取 text 分片；连续同角色合并（anthropic 要求交替）。
pub fn openai_to_upstream(req: &Value) -> Result<Value, String> {
    let msgs = req
        .get("messages")
        .and_then(|m| m.as_array())
        .ok_or("messages array required")?;
    let mut sys_extra: Vec<String> = vec![];
    let mut out_msgs: Vec<Value> = vec![];
    for m in msgs {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let text = match m.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(arr)) => {
                let mut parts: Vec<String> = vec![];
                for p in arr {
                    match (p.get("type").and_then(|t| t.as_str()), p.get("text").and_then(|t| t.as_str())) {
                        (Some("text"), Some(t)) => parts.push(t.to_string()),
                        (Some("image_url") | Some("input_audio") | Some("image"), _) => {
                            return Err("multimodal content not supported".into())
                        }
                        _ => {}
                    }
                }
                parts.join("\n\n")
            }
            _ => String::new(),
        };
        if text.is_empty() {
            continue;
        }
        if role == "system" || role == "developer" {
            sys_extra.push(text);
        } else {
            let r = if role == "assistant" { "assistant" } else { "user" };
            match out_msgs.last_mut() {
                Some(last) if last.get("role").and_then(|x| x.as_str()) == Some(r) => {
                    if let Some(Value::String(c)) = last.get_mut("content") {
                        c.push_str("\n\n");
                        c.push_str(&text);
                    }
                }
                _ => out_msgs.push(json!({ "role": r, "content": text })),
            }
        }
    }
    if out_msgs.is_empty() {
        return Err("messages array required".into());
    }

    let max_tokens = match req.get("max_tokens").and_then(|v| v.as_u64()) {
        Some(n) if n > 0 => n.min(128_000),
        _ => 4096,
    };

    let mut system: Vec<Value> = prefix_segs()
        .into_iter()
        .map(|t| json!({ "type": "text", "text": t, "cache_control": { "type": "ephemeral" } }))
        .collect();
    if !sys_extra.is_empty() {
        system.push(json!({ "type": "text", "text": sys_extra.join("\n\n"), "cache_control": { "type": "ephemeral" } }));
    }

    // metadata.user_id 形状与 anthropic 直通路径一致
    let uid = json!({
        "device_id": uuid::Uuid::new_v4().to_string(),
        "account_uuid": "",
        "session_id": "",
    }).to_string();
    let mut out = json!({
        "model": map_model(req.get("model").and_then(|m| m.as_str()).unwrap_or("")),
        "messages": out_msgs,
        "max_tokens": max_tokens,
        "stream": true,
        "system": system,
        "metadata": { "user_id": uid },
    });
    // OpenAI reasoning_effort: 仅 high 映射到上游 effort 档
    if req.get("reasoning_effort").and_then(|v| v.as_str()) == Some("high") {
        out["output_config"] = json!({ "effort": "high" });
    }
    if let Some(t) = req.get("temperature").filter(|v| v.is_number()) {
        out["temperature"] = t.clone();
    }
    if let Some(p) = req.get("top_p").filter(|v| v.is_number()) {
        out["top_p"] = p.clone();
    }
    if let Some(stops) = req.get("stop").filter(|v| v.is_array() || v.is_string()) {
        let seq = match stops {
            Value::String(s) => json!([s]),
            v => v.clone(),
        };
        out["stop_sequences"] = seq;
    }
    if let Some(tools) = req.get("tools").filter(|v| v.is_array() && !v.as_array().unwrap().is_empty()) {
        let mapped: Vec<Value> = tools
            .as_array().unwrap()
            .iter()
            .filter_map(|t| {
                let f = t.get("function")?;
                let name = f.get("name")?.as_str()?.to_string();
                let mut o = json!({ "name": name, "input_schema": f.get("parameters").cloned().unwrap_or(json!({ "type": "object" })) });
                if let Some(d) = f.get("description") {
                    o["description"] = d.clone();
                }
                Some(o)
            })
            .collect();
        if !mapped.is_empty() {
            out["tools"] = Value::Array(mapped);
        }
    }
    if let Some(tc) = req.get("tool_choice") {
        match tc {
            Value::String(s) if s == "auto" || s == "any" => { out["tool_choice"] = json!(s); }
            Value::Object(_) if tc.get("type").and_then(|x| x.as_str()) == Some("function") => {
                if let Some(n) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                    out["tool_choice"] = json!({ "type": "tool", "name": n });
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn openai_finish_reason(stop: Option<&str>) -> &'static str {
    match stop {
        Some("max_tokens") => "length",
        Some("tool_use") => "tool_calls",
        _ => "stop",
    }
}

/// 上游 SSE 聚合为 OpenAI chat.completion 非流式响应（M3）
/// anthropic 原生形态聚合（/v1/responses 的 text/usage 提取复用此结构）
pub fn aggregate_sse_to_anthropic(raw: &str, model: &str) -> Value {
    aggregate_sse(raw, model)
}

pub fn aggregate_sse_to_openai(raw: &str, model: &str) -> Value {
    let m = aggregate_sse(raw, model);
    let text = m
        .pointer("/content/0/text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let finish = openai_finish_reason(m.get("stop_reason").and_then(|s| s.as_str()));
    let usage_in = m.pointer("/usage/input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let usage_out = m.pointer("/usage/output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "model": model,
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": text }, "finish_reason": finish }],
        "usage": { "prompt_tokens": usage_in, "completion_tokens": usage_out, "total_tokens": usage_in + usage_out },
    })
}

/// 上游 anthropic SSE → OpenAI chat.completion.chunk 增量转换器（M3 流式）。
/// feed 吞任意切分的上游字节（内部按事件缓冲），返回可直接下发的 SSE 文本；finish 收尾并附 [DONE]。
pub struct OpenAiChunker {
    model: String,
    id: String,
    created: u64,
    buf: String,
    role_sent: bool,
    stop_reason: Option<String>,
    usage_in: i64,
    usage_out: i64,
}

impl OpenAiChunker {
    pub fn new(model: &str) -> Self {
        Self {
            model: model.to_string(),
            id: format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
            created: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            buf: String::new(),
            role_sent: false,
            stop_reason: None,
            usage_in: 0,
            usage_out: 0,
        }
    }

    fn chunk(&self, delta: Value, finish: Option<&str>) -> String {
        let body = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish.map(Value::from).unwrap_or(Value::Null) }],
        });
        format!("data: {body}\n\n")
    }

    pub fn feed(&mut self, text: &str) -> String {
        self.buf.push_str(text);
        let mut out = String::new();
        while let Some(pos) = self.buf.find("\n\n") {
            let event: String = self.buf.drain(..pos + 2).collect();
            for line in event.lines() {
                let data = match line.strip_prefix("data: ") {
                    Some(d) => d.trim(),
                    None => continue,
                };
                let ev: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match ev.get("type").and_then(|t| t.as_str()) {
                    Some("message_start") => {
                        self.usage_in = ev
                            .pointer("/message/usage/input_tokens")
                            .and_then(|x| x.as_i64())
                            .unwrap_or(self.usage_in);
                        if !self.role_sent {
                            self.role_sent = true;
                            out.push_str(&self.chunk(json!({ "role": "assistant", "content": "" }), None));
                        }
                    }
                    Some("content_block_delta") => {
                        if ev.pointer("/delta/type").and_then(|x| x.as_str()) == Some("text_delta") {
                            if let Some(t) = ev.pointer("/delta/text").and_then(|x| x.as_str()) {
                                out.push_str(&self.chunk(json!({ "content": t }), None));
                            }
                        }
                        // thinking_delta 不透出：OpenAI 协议无对应字段
                    }
                    Some("message_delta") => {
                        self.stop_reason = ev.pointer("/delta/stop_reason").and_then(|x| x.as_str()).map(|s| s.to_string());
                        if let Some(u) = ev.pointer("/usage/output_tokens").and_then(|x| x.as_i64()) {
                            self.usage_out = u;
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }

    pub fn finish(&mut self) -> String {
        let mut out = String::new();
        if !self.role_sent {
            self.role_sent = true;
            out.push_str(&self.chunk(json!({ "role": "assistant", "content": "" }), None));
        }
        let finish = openai_finish_reason(self.stop_reason.as_deref());
        let final_chunk = json!({
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{ "index": 0, "delta": {}, "finish_reason": finish }],
            "usage": { "prompt_tokens": self.usage_in, "completion_tokens": self.usage_out, "total_tokens": self.usage_in + self.usage_out },
        });
        out.push_str(&format!("data: {final_chunk}\n\ndata: [DONE]\n\n"));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_request_conversion() {
        let req = json!({
            "model": "glm-5.3-flash",
            "messages": [
                { "role": "system", "content": "be brief" },
                { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
                { "role": "assistant", "content": "hello" },
                { "role": "assistant", "content": "again" },
                { "role": "user", "content": "next" }
            ],
            "max_tokens": 100, "temperature": 0.5, "stop": "END",
            "tools": [{ "type": "function", "function": { "name": "f", "description": "d", "parameters": { "type": "object" } } }]
        });
        let out = openai_to_upstream(&req).unwrap();
        assert_eq!(out["model"], "GLM-5.3-Flash");
        assert_eq!(out["stream"], true);
        // system 段入前缀后的追加块；连续同角色 assistant 合并为一条
        let sys = out["system"].as_array().unwrap();
        assert_eq!(sys.last().unwrap()["text"], "be brief");
        assert!(sys.last().unwrap()["cache_control"].is_object());
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "hello\n\nagain");
        assert_eq!(out["stop_sequences"], json!(["END"]));
        assert_eq!(out["tools"][0]["name"], "f");
        assert!(out["tools"][0]["input_schema"].is_object());
    }

    #[test]
    fn chunker_survives_split_events() {
        let sse = concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"你\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        );
        let mut c = OpenAiChunker::new("GLM-5.3-Flash");
        // 故意按撕裂事件边界切两半喂入，验证内部缓冲
        let (a, b) = sse.split_at(sse.len() / 2);
        let out = format!("{}{}", c.feed(a), c.feed(b));
        assert!(out.contains("\"role\":\"assistant\""));
        assert_eq!(out.matches("\"content\":\"你\"").count(), 1);
        assert_eq!(out.matches("\"content\":\"好\"").count(), 1);
        let fin = c.finish();
        assert!(fin.contains("\"finish_reason\":\"stop\""));
        assert!(fin.contains("\"total_tokens\":11"));
        assert!(fin.contains("data: [DONE]"));
    }
}
