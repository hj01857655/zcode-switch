// GATEWAY 配置：端口、调用方鉴权密钥，落 ~/.zcode-switch/gateway.json（与账号库同目录）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
    /// 上游连接超时（秒）。读超时不设：SSE 流式回答持续几分钟是正常形态，整体超时会掐断流
    #[serde(default = "d_connect")]
    pub upstream_connect_secs: u64,
    /// 换号重试次数（首次尝试之外）
    #[serde(default = "d_retries")]
    pub max_retries: u32,
    /// 账号粘性：开 = 成功后驻留同号（上游 prompt cache 命中），关 = 每请求轮换分摊
    #[serde(default = "d_true")]
    pub sticky: bool,
    /// 3012 等全局风控后的整体退避（秒）
    #[serde(default = "d_backoff")]
    pub global_backoff_secs: u64,
    /// 跟随应用自启：start/stop 时落盘，应用启动时按此恢复
    #[serde(default)]
    pub auto_start: bool,
    /// CORS 允许来源（精确匹配；"*" 放行全部）。空 = 不发 CORS 头，浏览器端调用会被拦，本机 CLI 无感
    #[serde(default)]
    pub cors_origins: Vec<String>,
    /// 单请求体上限（MB）。axum 默认 2MB，大上下文对话会被掐，默认放宽到 32
    #[serde(default = "d_body_limit")]
    pub body_limit_mb: u64,
    /// 请求日志是否落盘 gateway.jsonl
    #[serde(default = "d_true")]
    pub log_to_disk: bool,
    /// 日志文件超过此大小（MB）轮转为 gateway.jsonl.1
    #[serde(default = "d_log_max")]
    pub log_file_max_mb: u64,
}

fn d_connect() -> u64 { 15 }
fn d_retries() -> u32 { 1 }
fn d_backoff() -> u64 { 600 }
fn d_body_limit() -> u64 { 32 }
fn d_true() -> bool { true }
fn d_log_max() -> u64 { 16 }

impl Default for GatewayConfig {
    fn default() -> Self {
        // 密钥默认自动生成（sk- + 32 hex），首次落盘后固定
        Self {
            port: 8081,
            api_key: format!("sk-{}", uuid::Uuid::new_v4().simple()),
            upstream_connect_secs: d_connect(),
            max_retries: d_retries(),
            sticky: d_true(),
            global_backoff_secs: d_backoff(),
            auto_start: false,
            cors_origins: Vec::new(),
            body_limit_mb: d_body_limit(),
            log_to_disk: d_true(),
            log_file_max_mb: d_log_max(),
        }
    }
}

impl GatewayConfig {
    fn path() -> PathBuf {
        crate::Paths::detect().store_dir().join("gateway.json")
    }

    pub fn load() -> Self {
        let p = Self::path();
        if p.exists() {
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str(&s) {
                    return v;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), String> {
        let p = Self::path();
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        Ok(())
    }
}
