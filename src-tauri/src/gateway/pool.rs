// GATEWAY 农场调度：账号库投影 + 粘性轮转 + 冷却 + 在飞上限 + 3012 全局退避。
// 设计见 docs/GATEWAY.md §3。调度状态纯内存（游标/冷却表重启清零），不落第二份盘。
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 单号在飞请求上限：多客户端挤同号会撞 3008/3009/3010 并发档
pub const MAX_INFLIGHT: u32 = 2;

/// 3012/405 全局退避：WAF 判的是 IP+指纹不是账号，单号冷却会让重放循环把整池指纹喂脏
pub const GLOBAL_BACKOFF_SECS: u64 = 10 * 60;

pub struct PoolMember {
    pub id: String,
    pub name: String,
    pub token: String,
    pub mid: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// 下一次 pick 的起点。粘性开：成功后停在被选中号上，失败后 +1（换号）；
    /// 粘性关（轮换）：成功也 +1，池内分摊
    cursor: usize,
    /// 账号粘性开关（配置面，serve 启动时写入）
    sticky: bool,
    inflight: HashMap<String, u32>,
    cool: HashMap<String, Instant>,
    global_until: Option<Instant>,
    /// 累计请求计数（成功/失败，settle 落账）
    total_ok: u64,
    total_err: u64,
}

pub struct Pool(Mutex<Inner>);

impl Pool {
    pub fn new() -> Self {
        Self(Mutex::new(Inner { sticky: true, ..Default::default() }))
    }

    /// 粘性开关（配置面）：开 = 成功后驻留同号（吃上游 prompt cache 命中），关 = 每请求轮换分摊
    pub fn set_sticky(&self, v: bool) {
        if let Ok(mut inner) = self.0.lock() {
            inner.sticky = v;
        }
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
    pub fn pick(&self, members: &[PoolMember]) -> Option<usize> {
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

    /// 请求收尾：在飞 -1；失败时游标挪到下一号并按档落冷却；
    /// 成功时仅粘性关才挪游标（轮换分摊）——粘性的全部实现就是这一处分支
    pub fn settle(&self, member_id: &str, idx: usize, member_count: usize, ok: bool, cooldown_secs: u64) {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if ok { inner.total_ok += 1 } else { inner.total_err += 1 }
        if let Some(c) = inner.inflight.get_mut(member_id) {
            *c = c.saturating_sub(1);
        }
        if member_count > 0 && (!ok || !inner.sticky) {
            inner.cursor = (idx + 1) % member_count;
        }
        if !ok && cooldown_secs > 0 {
            inner
                .cool
                .insert(member_id.to_string(), Instant::now() + Duration::from_secs(cooldown_secs));
        }
    }

    pub fn global_backoff(&self, secs: u64) {
        if let Ok(mut inner) = self.0.lock() {
            inner.global_until = Some(Instant::now() + Duration::from_secs(secs));
        }
    }

    /// 状态快照：账号 id → 冷却剩余秒；全局退避；累计计数。twoapi_status / 前端池可视化消费。
    pub fn snapshot(&self, members: &[PoolMember]) -> Value {
        let mut inner = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return Value::Null,
        };
        Self::sweep(&mut inner);
        let now = Instant::now();
        let members_json: Vec<Value> = members
            .iter()
            .map(|m| {
                let cool_left = inner
                    .cool
                    .get(&m.id)
                    .and_then(|t| t.saturating_duration_since(now).as_secs().into())
                    .unwrap_or(0u64);
                json!({
                    "id": m.id, "name": m.name,
                    "inflight": inner.inflight.get(&m.id).copied().unwrap_or(0),
                    "cooldown_secs": cool_left,
                })
            })
            .collect();
        json!({
            "members": members_json,
            "global_backoff_secs": inner.global_until
                .and_then(|t| t.saturating_duration_since(now).as_secs().into())
                .unwrap_or(0u64),
            "total_ok": inner.total_ok,
            "total_err": inner.total_err,
        })
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
pub fn members() -> Result<Vec<PoolMember>, String> {
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
        out.push(PoolMember {
            id: a.id,
            name: a.name,
            token,
            mid,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members2() -> Vec<PoolMember> {
        vec![
            PoolMember { id: "a".into(), name: "A".into(), token: "t".into(), mid: None },
            PoolMember { id: "b".into(), name: "B".into(), token: "t".into(), mid: None },
        ]
    }

    #[test]
    fn sticky_stays_on_success_rotates_when_off() {
        let m = members2();
        let pool = Pool::new();
        // 粘性：成功后驻留同号
        let i = pool.pick(&m).unwrap();
        pool.settle(&m[i].id, i, m.len(), true, 0);
        assert_eq!(pool.pick(&m).unwrap(), i);
        // 轮换：成功也让游标前移
        pool.set_sticky(false);
        let i = pool.pick(&m).unwrap();
        pool.settle(&m[i].id, i, m.len(), true, 0);
        assert_eq!(pool.pick(&m).unwrap(), (i + 1) % m.len());
        // 失败永远换号 + 落冷却
        let i = pool.pick(&m).unwrap();
        pool.settle(&m[i].id, i, m.len(), false, 60);
        let j = pool.pick(&m).unwrap();
        assert_ne!(j, i);
        assert!(pool.snapshot(&m)["members"][i]["cooldown_secs"].as_u64().unwrap() > 0);
    }
}
