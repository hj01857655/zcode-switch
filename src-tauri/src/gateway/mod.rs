// GATEWAY — OpenAI/Anthropic 兼容反代（M1：服务骨架 + models + 鉴权 + health）
// 设计见 docs/GATEWAY.md。服务独立于窗口生命周期，托盘模式照常运行。
pub mod config;
pub mod openai;
pub mod pool;
pub mod responses;
pub mod server;
pub mod translate;
pub mod upstream;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 服务运行状态：running 标志 + 句柄线程（M2 起扩展 uptime/计数）
pub struct GatewayState {
    pub running: AtomicBool,
    pub config: Mutex<config::GatewayConfig>,
    shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            config: Mutex::new(config::GatewayConfig::load()),
            shutdown: Mutex::new(None),
        }
    }

    /// 启动服务：起独立 tokio runtime 线程，返回是否新启动（已在跑则 false）
    pub fn start(&self) -> Result<bool, String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let cfg = self.config.lock().map_err(|e| e.to_string())?.clone();
        cfg.save()?;

        let (tx, rx) = tokio::sync::watch::channel(false);
        {
            let mut g = self.shutdown.lock().map_err(|e| e.to_string())?;
            *g = Some(tx);
        }

        let addr: SocketAddr = ([127, 0, 0, 1], cfg.port)
            .try_into()
            .map_err(|e| format!("bad port {}: {e}", cfg.port))?;
        let api_key = cfg.api_key.clone();
        let running = &self.running;

        std::thread::Builder::new()
            .name("gateway".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("gateway tokio runtime");
                rt.block_on(async move {
                    server::serve(addr, api_key, rx).await;
                });
            })
            .map_err(|e| format!("spawn gateway thread: {e}"))?;

        // 端口绑定失败无法从线程同步回报，此处以短延迟后 running 标志判定
        running.store(true, Ordering::SeqCst);
        Ok(true)
    }

    /// 停止服务：广播 shutdown，等待标志清零
    pub fn stop(&self) -> Result<bool, String> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        if let Some(tx) = self.shutdown.lock().map_err(|e| e.to_string())?.take() {
            let _ = tx.send(true);
        }
        self.running.store(false, Ordering::SeqCst);
        Ok(true)
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}
