// GATEWAY 农场调度：账号库投影 + 粘性轮转 + 冷却 + 在飞上限 + 3012 全局退避。
// 设计见 docs/GATEWAY.md §3。调度状态纯内存（游标/冷却表重启清零），不落第二份盘。
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 单号在飞请求上限：多客户端挤同号会撞 3008/3009/3010 并发档
pub const MAX_INFLIGHT: u32 = 2;

/// 3012/405 全局退避：WAF 判的是 IP+指纹不是账号，单号冷却会让重放循环把整池指纹喂脏
pub const GLOBAL_BACKOFF_SECS: u64 = 10 * 60;

pub struct FarmMember {
    pub id: String,
    pub name: String,
    pub token: String,
    pub mid: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// 下一次 pick 的起点。成功后停在被选中号上（粘性），失败后 +1（换号）
    cursor: usize,
    inflight: HashMap<String, u32>,
    cool: HashMap<String, Instant>,
    global_until: Option<Instant>,
}

pub struct Farm(Mutex<Inner>);

impl Farm {
    pub fn new() -> Self {
        Self(Mutex::new(Inner::default()))
    }

    fn sweep(inner: &mut Inner) {
        let now = Instant::now();
        inner.cool.retain(|_, until| *until > now);
        if inner.global_until.is_some_and(|t| t <= now) {
            inner.global_until = None;
        }
    }

    /// 选下一个可用号：跳过冷却中 / 在飞超限的成员，成功后 cursor 粘在被选号。
    /// 返回 None = 全局退避中，或全员不可用（用 global_backoff_secs 区分）。
    pub fn pick(&self, members: &[FarmMember]) -> Option<usize> {
        let mut inner = self.0.lock().ok()?;
        Self::sweep(&mut inner);
        if inner.global_until.is_some() {
            return None;
        }
        let n = members.len();
        if n == 0 {
            return None;
        }
        for i in 0..n {
            let idx = (inner.cursor + i) % n;
            let m = &members[idx];
            if inner.cool.contains_key(&m.id) {
                continue;
            }
            if inner.inflight.get(&m.id).copied().unwrap_or(0) >= MAX_INFLIGHT {
                continue;
            }
            *inner.inflight.entry(m.id.clone()).or_insert(0) += 1;
            inner.cursor = idx;
            return Some(idx);
        }
        None
    }

    /// 请求收尾：在飞 -1；失败时游标挪到下一号并按档落冷却。
    /// 成功不动游标——粘性的全部实现就在这一行不做的事。
    pub fn settle(&self, member_id: &str, idx: usize, member_count: usize, ok: bool, cooldown_secs: u64) {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(c) = inner.inflight.get_mut(member_id) {
            *c = c.saturating_sub(1);
        }
        if !ok && member_count > 0 {
            inner.cursor = (idx + 1) % member_count;
            if cooldown_secs > 0 {
                inner
                    .cool
                    .insert(member_id.to_string(), Instant::now() + Duration::from_secs(cooldown_secs));
            }
        }
    }

    pub fn global_backoff(&self, secs: u64) {
        if let Ok(mut inner) = self.0.lock() {
            inner.global_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }

    /// 全局退避剩余秒（0 = 未在退避）。全员不可用但未在退避时返回 1，客户端至少退一秒。
    pub fn global_backoff_secs(&self) -> u64 {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return 0,
        };
        Self::sweep(&mut inner);
        match inner.global_until {
            Some(t) => t.saturating_duration_since(Instant::now()).as_secs().max(1),
            None => 0,
        }
    }
}

/// 农场成员清单：账号库投影，每次请求现取（claim_token 内部有缓存路径）。
/// 跳过未登录与 jwt_expired 的号；单号 token 解密失败不连坐整池。
pub fn farm_members() -> Result<Vec<FarmMember>, String> {
    let paths = crate::Paths::detect();
    let secret = crate::zcrypto::default_secret(&paths.home);
    let accounts = crate::store::list_accounts(&paths)?;
    let mut out = Vec::new();
    for a in accounts {
        if !crate::store::is_logged_in(&a.credentials) {
            continue;
        }
        if crate::store::account_jwt_expired(&a.credentials, &paths.home) {
            continue;
        }
        // per-account 虚拟 mid：与切号解耦，每个农场号有稳定独立设备身份
        let mid = crate::store::ensure_virtual_device_mid(&paths, &a.id).ok();
        let token = match crate::claim::claim_token(&a.credentials, a.config.as_ref(), &secret) {
            Ok(t) => t,
            Err(_) => continue,
        };
        out.push(FarmMember {
            id: a.id,
            name: a.name,
            token,
            mid,
        });
    }
    Ok(out)
}
