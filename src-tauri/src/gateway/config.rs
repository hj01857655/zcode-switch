// GATEWAY 配置：端口、调用方鉴权密钥，落 ~/.zcode-switch/gateway.json（与账号库同目录）
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub port: u16,
    #[serde(default)]
    pub api_key: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        // 密钥默认自动生成（sk- + 32 hex），首次落盘后固定
        Self {
            port: 8081,
            api_key: format!("sk-{}", uuid::Uuid::new_v4().simple()),
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
