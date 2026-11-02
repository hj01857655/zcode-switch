// 仪表盘页：状态摘要卡（可点击跳转）+ 网关运行区（池健康 + 今日请求聚合）+ 账号额度明细。
// 对照 new-api/LiteLLM 看板结构（摘要卡 → 用量聚合 → 明细表）。数据全部取自
// store（sweep 自动刷新）、gateway_status（5s 轮询）与 gateway_log_history（30s 聚合），不新增后端命令。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { store, subscribe, getVersion, accountName } from "../lib/store.js";
import { expireInfo, tierBadges, slotRows, windowLabel, itemKind, balLabel, fmtTokens, planItems, quotaTotals } from "../lib/quotaView.js";
import { TierBadges } from "../components/QuotaView.jsx";

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function Card({ label, value, cls, ic, onClick }) {
  return (
    <div
      className={"dash-card" + (cls === "ok" ? " state-ok" : "") + (onClick ? " clickable" : "")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      title={onClick ? t("d.clickHint") : undefined}
    >
      <div className="dash-label">{ic ? <Ic name={ic} size={12} /> : null}{label}</div>
      <div className={"dash-value" + (cls ? " " + cls : "")}>{value}</div>
    </div>
  );
}

// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));

// 统一取条目：多套餐取各自 items；套餐无条目但直接挂 total/remaining 的池级兜底形态
// （quota.rs 无 slots 路径）合成伪条目参与聚合；
// 每条打上套餐标签 __plan：slotRows 的同名去重只在同一套餐内生效，
// 否则 weekly build 与 start plan 同名池条跨套餐互吞，只算到一个
function planItems(data) {
  const plans = data?.plans || [];
  if (plans.length) {
    return plans.flatMap((p, pi) => {
      const tag = p.name || p.tier || `plan${pi}`;
      const items = (p.items || []).length
        ? p.items
        : (p.total != null || p.remaining != null)
          ? [{ name: p.name || p.tier || "plan", total: p.total, remaining: p.remaining, percent_used: p.percent_used }]
          : [];
      return items.map((it) => ({ ...it, __plan: tag }));
    });
  }
  return (data?.items || []).map((it) => ({ ...it, __plan: "" }));
}

// 行内额度摘录：合并各 plan 同名窗口取已用最大者，窗口条优先于池条，最多 2 个
function quotaChips(data) {
  if (!data) return [];
  const { wins, pools } = slotRows(planItems(data));
  const byLabel = new Map();
  for (const it of [...wins, ...pools]) {
    const l = itemKind(it) === "raw" ? balLabel(it.name) : windowLabel(it);
    const cur = byLabel.get(l);
    if (!cur || (it.percent_used || 0) > (cur.percent_used || 0)) byLabel.set(l, it);
  }
  return [...byLabel.values()].slice(0, 2).map((it) => ({ label: windowLabel(it), pct: it.percent_used }));
}

// 全账号额度聚合：按套餐分行（套餐名做前缀），同套餐跨账号求和。
// 不跨套餐合并：weekly build 与 start plan 的 tier_code 同为 start，档位区分不了，
// 只有套餐自己的 plan_id/name 能区分（quota.rs 原样透传到 p.name/p.pid），同名条目分属不同套餐时必须分行
function quotaTotals(accounts) {
  const byLabel = new Map();
  const put = (l, it) => {
    if (it.total == null && it.remaining == null) return;
    const cur = byLabel.get(l) || { rem: 0, tot: 0 };
    cur.rem += it.remaining || 0;
    cur.tot += it.total || 0;
    byLabel.set(l, cur);
  };
  for (const a of accounts) {
    const data = store.acctQuota[a.id]?.data;
    if (!data) continue;
    for (const it of planItems(data)) {
      // 时长窗口（分钟）没有可加总的语义，且 fmtTokens 会把分钟排成 K/M 误导，排除
      if (itemKind(it) === "duration") continue;
      const base = itemKind(it) === "raw" ? balLabel(it.name) : windowLabel(it);
      put(it.__plan ? `${it.__plan} · ${base}` : base, it);
    }
  }
  return [...byLabel.entries()]
    .filter(([, v]) => v.rem > 0 || v.tot > 0)
    .slice(0, 4)
    .map(([label, v]) => ({ label, rem: v.rem, tot: v.tot }));
}

export default function DashboardPage({ onNavigate }) {
  useStore();
  const [gw, setGw] = useState(null);
  const [logs, setLogs] = useState(null);
  const [stamp, setStamp] = useState(null);

  // gateway_status 5s 轮询：挂载拉一次会陈旧（网关在别页启停）
  useEffect(() => {
    let alive = true;
    const pull = () => invoke("gateway_status")
      .then((v) => { if (alive) setGw(v); })
      .catch(() => {});
    pull();
    const id = setInterval(pull, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // 网关运行中才聚合请求日志（30s，足够看板口径）
  const gwOn = !!gw?.running;
  useEffect(() => {
    if (!gwOn) { setLogs(null); return; }
    let alive = true;
    const pull = () => invoke("gateway_log_history")
      .then((v) => { if (alive) { setLogs(v || []); setStamp(new Date()); } })
      .catch(() => {});
    pull();
    const id = setInterval(pull, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [gwOn]);

  const s = store.state || {};
  const accounts = s.accounts || [];
  const active = accounts.find((a) => a.is_active) || null;
  const claimable = accounts.filter((a) => (store.claimable[a.id]?.plans || []).length > 0).length;

  // 今日请求聚合（本地日界）：请求/成功/失败/p95/token/缓存命中
  const today = useMemo(() => {
    const v = logs ?? [];
    const now = new Date().toDateString();
    const td = v.filter((l) => { try { return new Date(l.ts).toDateString() === now; } catch { return false; } });
    const ok = td.filter((l) => l.ok).length;
    const mss = td.map((l) => l.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
    const p95 = mss.length ? mss[Math.min(mss.length - 1, Math.floor(mss.length * 0.95))] : null;
    const sum = (k) => td.reduce((a, l) => a + (l[k] || 0), 0);
    const tin = sum("tin");
    const tcr = sum("tcr");
    return {
      n: td.length, ok, fail: td.length - ok, p95,
      tin, tout: sum("tout"), tcr, tcw: sum("tcw"),
      hitRate: tin + tcr > 0 ? Math.round((tcr / (tin + tcr)) * 100) : null,
    };
  }, [logs]);

  const pool = gw?.pool;
  const members = pool?.members ?? [];
  const cooling = members.filter((m) => m.cooldown_secs > 0).length;
  const inflight = members.reduce((a, m) => a + (m.inflight || 0), 0);
  const totals = quotaTotals(accounts.map((a) => store.acctQuota[a.id]?.data).filter(Boolean));

  return (
    <div className="settings">
      <div className="section-head">
        <h2>{t("d.menu")}</h2>
      </div>
      <div className="dash-cards">
        <Card label={t("d.accCount")} value={accounts.length} ic="list" onClick={() => onNavigate?.("accounts")} />
        <Card
          label={t("d.claimable")}
          value={claimable ? t("d.claimableN", { n: claimable }) : t("d.claimableNone")}
          cls={claimable ? "ok" : "dim"}
          ic="gift"
          onClick={() => onNavigate?.("accounts")}
        />
        <Card
          label={t("d.zcodeState")}
          value={<><Ic name="power" size={14} /> {s.zcode_running ? t("d.zcodeRun") : t("d.zcodeStop")}</>}
          cls={s.zcode_running ? "ok" : "dim"}
          ic="play"
          onClick={() => onNavigate?.("accounts")}
        />
        <Card
          label={t("d.gateway")}
          value={gwOn ? t("d.gatewayOn", { port: gw.port ?? 8081 }) : t("d.gatewayOff")}
          cls={gwOn ? "ok" : "dim"}
          ic="swap"
          onClick={() => onNavigate?.("gateway")}
        />
        <Card
          label={t("d.autoClaim")}
          value={s.auto_claim ? t("d.on") : t("d.off")}
          cls={s.auto_claim ? "ok" : "dim"}
          ic="refresh"
          onClick={() => onNavigate?.("settings")}
        />
        <Card label={t("d.current")} value={active?.name || t("d.none")} cls={active ? "" : "dim"} ic="check" onClick={() => onNavigate?.("accounts")} />
      </div>

      {/* 网关运行区：池健康一行 + 今日请求聚合（new-api 看板同思路的用量块） */}
      <div className="dash-gw">
        <div className="dash-gw-head">
          <span className="dash-gw-title"><Ic name="swap" size={13} /> {t("d.gwSection")}</span>
          {gwOn
            ? <span className="dash-gw-port">{t("d.gatewayOn", { port: gw.port ?? 8081 })}</span>
            : <button className="btn-ghost" onClick={() => onNavigate?.("gateway")}>{t("d.gwGoStart")}</button>}
        </div>
        {gwOn
          ? <>
              <div className="dash-gw-row">
                <span>{t("x.poolSummary", { n: members.length - cooling, cool: cooling, inflight, total: members.length })}</span>
                {pool?.global_backoff_secs > 0
                  ? <span className="warn">{t("x.globalBackoff")} {pool.global_backoff_secs}s</span>
                  : null}
                {stamp ? <span className="dash-stamp">{t("d.updatedAt", { time: stamp.toLocaleTimeString([], { hour12: false }) })}</span> : null}
              </div>
              {!logs
                ? <div className="dash-gw-note">{t("d.gwLoading")}</div>
                : today.n === 0
                  ? <div className="dash-gw-note">{t("d.gwNoReq")}</div>
                  : <div className="x-ls-stats">
                    <div className="x-ls-group">
                      <span className="x-ls-group-label">{t("d.gwToday")}</span>
                      <div className="x-stat"><span className="x-stat-v">{today.n}</span><span className="x-stat-k">{t("xl.total")}</span></div>
                      <div className="x-stat"><span className="x-stat-v ok">{today.ok}</span><span className="x-stat-k">{t("xl.ok")}</span></div>
                      <div className="x-stat"><span className="x-stat-v fail">{today.fail}</span><span className="x-stat-k">{t("xl.fail")}</span></div>
                      <div className="x-stat"><span className="x-stat-v">{Math.round((today.ok / today.n) * 100)}<small>%</small></span><span className="x-stat-k">{t("d.gwOkRate")}</span></div>
                    </div>
                    {today.p95 != null
                      ? <div className="x-ls-group">
                          <span className="x-ls-group-label">{t("d.gwLatency")}</span>
                          <div className="x-stat"><span className="x-stat-v">{today.p95}<small>ms</small></span><span className="x-stat-k">p95</span></div>
                        </div>
                      : null}
                    <div className="x-ls-group">
                      <span className="x-ls-group-label">{t("d.gwTokens")}</span>
                      <div className="x-stat"><span className="x-stat-v">{fmtTok(today.tin)}<small>↓</small></span><span className="x-stat-k">{t("x.tokIn")}</span></div>
                      <div className="x-stat"><span className="x-stat-v">{fmtTok(today.tout)}<small>↑</small></span><span className="x-stat-k">{t("x.tokOut")}</span></div>
                    </div>
                    <div className="x-ls-group">
                      <span className="x-ls-group-label">{t("d.gwCache")}</span>
                      <div className="x-stat"><span className="x-stat-v">{fmtTok(today.tcr)}<small>⚡</small></span><span className="x-stat-k">{t("x.tokCacheR")}</span></div>
                      {today.hitRate != null
                        ? <div className="x-stat"><span className="x-stat-v">{today.hitRate}<small>%</small></span><span className="x-stat-k">{t("d.gwHitRate")}</span></div>
                        : null}
                  </div>
                </div>}
            </>
          : null}
      </div>

      <div className="dash-sub">
        <Ic name="list" size={13} /> {t("d.accSection")}
        {accounts.length
          ? <span className="dash-sub-total">
              <span className="dash-sub-total-label">{t("d.quotaTotal")}</span>
              {totals.length
                ? totals.map((v) => (
                    <span key={v.label} className="dash-q">
                      {v.label} <b>{t("q.remainShort")} {fmtTokens(v.rem)}/{fmtTokens(v.tot)}</b>
                    </span>
                  ))
                : <span className="dash-q dash-q-pending">…</span>}
            </span>
          : null}
      </div>
      <div className="dash-list">
        {accounts.map((a) => {
          const q = store.acctQuota[a.id]?.data;
          const exp = expireInfo(q?.plan_expire, q?.plan_starts);
          return (
            <div key={a.id} className={"dash-row clickable" + (a.is_active ? " active" : "")}
              onClick={() => onNavigate?.("accounts", a.id)} role="button" title={t("d.clickHint")}>
              <span className="dash-row-name" title={a.id}>{a.name}</span>
              <TierBadges pairs={tierBadges(q)} />
              <div className="dash-row-quota">
                {quotaChips(q).map((c, i) => (
                  <span key={i} className="dash-q">
                    {c.label} <b className={c.pct >= 90 ? "danger" : c.pct >= 70 ? "warn" : ""}>
                      {c.pct == null ? "--" : Math.round(c.pct) + "%"}
                    </b>
                  </span>
                ))}
              </div>
              <span className="dash-row-meta">
                {exp ? t("q.validUntil", { date: exp.text }) : t("q.unknown")}
              </span>
            </div>
          );
        })}
        {accounts.length === 0 ? <div className="dash-empty">{t("m.emptyTitle")}</div> : null}
      </div>
    </div>
  );
}
