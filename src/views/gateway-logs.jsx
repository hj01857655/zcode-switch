// React 版 Gateway 日志页：gateway.jsonl 全量历史（尾部 2000 行），筛选 + 统计 + 行展开详情。
// 独立成页的原因：网关页已承载端点/协议/模型/池/配置/curl 六块，日志的全量历史、
// 筛选、统计放不下——网关页只留内存环摘要，本页做运维面（筛选/聚合/详情）。
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";

// 行视觉辅助：相对时间 / 方法徽章 / 状态与耗时分档着色
const epMethod = (ep) => (ep || "").split(" ")[0].toUpperCase();
const epPath = (ep) => (ep || "").includes(" ") ? (ep || "").split(" ").slice(1).join(" ") : ep || "";
const relTime = (ts) => {
  const d = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(d) || d < 0) return ts;
  const s = Math.floor(d / 1000);
  if (s < 10) return t("xl.justNow");
  if (s < 60) return t("xl.secAgo", { n: s });
  if (s < 3600) return t("xl.minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("xl.hourAgo", { n: Math.floor(s / 3600) });
  return t("xl.dayAgo", { n: Math.floor(s / 86400) });
};
const msTier = (ms) => (ms == null ? "" : ms < 1000 ? "" : ms < 5000 ? " warn" : " bad");
const stTier = (st) => (st >= 500 ? " bad" : st >= 400 ? " warn" : " ok");
// req/resp 落盘时可能被截断：能解析就美化，不能就原样
const prettyJson = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };
// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));

function LogRow({ l }) {
  const [open, setOpen] = useState(false);
  const hasDetail = l.model != null || l.ms != null || l.err != null || l.attempt != null || l.stream != null;
  return (
    <>
      <div className={"x-log-row" + (hasDetail ? " clickable" : "")} onClick={() => hasDetail && setOpen(!open)}>
        <span className="x-log-ts" title={new Date(l.ts).toLocaleString()}>{relTime(l.ts)}</span>
        <span className="x-log-ep">
          <span className={"x-log-method" + (epMethod(l.ep) === "GET" ? " get" : "")}>{epMethod(l.ep)}</span>
          <span className="x-log-path">{epPath(l.ep)}</span>
        </span>
        <span className="x-log-acct" title={l.account}>{l.account ?? "—"}</span>
        <span className="x-log-model">{l.model ?? "—"}</span>
        <span className={"x-log-ms" + msTier(l.ms)}>{l.ms != null ? `${l.ms}ms` : "—"}</span>
        <span className="x-log-tok" title={`${t("x.tokOut")} ${l.tout ?? 0} · ${t("x.tokIn")} ${l.tin ?? 0}`}>{(!l.tin && !l.tout) ? "—" : `${fmtTok(l.tout || 0)}↑/${fmtTok(l.tin || 0)}↓`}</span>
        <span className="x-log-cache" title={`${t("x.tokCacheR")} ${l.tcr ?? 0} · ${t("x.tokCacheW")} ${l.tcw ?? 0}`}>{(l.tcr || l.tcw) ? `${fmtTok(l.tcr || 0)}+${fmtTok(l.tcw || 0)}` : "—"}</span>
        <span className={"x-log-code " + (l.ok ? stTier(l.status) : " bad")}>
          <span className="x-log-dot" />{l.status}
        </span>
      </div>
      {hasDetail && open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            <div className="x-log-meta">
              <div className="x-log-tokens">
                <span className="x-tok">↑ {t("x.tokIn")} {l.tin ?? 0}</span>
                <span className="x-tok">↓ {t("x.tokOut")} {l.tout ?? 0}</span>
                <span className={"x-tok" + ((l.tcr ?? 0) > 0 ? " hit" : "")}>⚡ {t("x.tokCacheR")} {l.tcr ?? 0}</span>
                <span className={"x-tok" + ((l.tcw ?? 0) > 0 ? " hit" : "")}>✎ {t("x.tokCacheW")} {l.tcw ?? 0}</span>
                <span className="x-tok">⏱ {l.ms != null ? `${l.ms}ms` : "—"}</span>
              </div>
              <button className="btn-ghost x-log-copy"
                onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(JSON.stringify(l, null, 2)).catch(() => {}); }}>
                {t("x.copyJson")}
              </button>
            </div>
            <div className="x-log-kv">
              <span className="x-log-k">{t("x.logColModel")}</span><span className="x-log-v">{l.model ?? "—"}{l.stream != null ? ` · ${t(l.stream ? "x.stream" : "x.nonStream")}` : ""}</span>
              <span className="x-log-k">{t("x.logColAcct")}</span><span className="x-log-v">{l.account ?? "—"}</span>
              {l.attempt != null && l.attempt > 0 ? <><span className="x-log-k">{t("x.logAttempt")}</span><span className="x-log-v">{l.attempt + 1}</span></> : null}
              <span className="x-log-k">{t("x.logColCode")}</span><span className={"x-log-v " + (l.ok ? "ok" : "fail")}>{l.status}</span>
            </div>
            {["req", "resp"].filter((k) => l[k]).map((k) => (
              <div className="x-log-block" key={k}>
                <div className="x-log-block-head">
                  <span>{k === "req" ? t("x.logReq") : t("x.logResp")}</span>
                  <button className="btn-ghost x-log-copy"
                    onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(l[k]).catch(() => {}); }}>
                    {t("x.copyBtn")}
                  </button>
                </div>
                <pre className="x-log-pre">{prettyJson(l[k])}</pre>
              </div>
            ))}
            {l.err ? <div className="x-log-err">{l.err}</div> : null}
          </div>
        : null}
    </>
  );
}

export default function GatewayLogsPage() {
  const [logs, setLogs] = useState(null);
  const [err, setErr] = useState("");
  const [epFilter, setEpFilter] = useState("");
  const [okFilter, setOkFilter] = useState(""); // "" | "ok" | "fail"
  const [auto, setAuto] = useState(false);

  const reload = () => {
    invoke("gateway_log_history")
      .then((v) => setLogs(v || []))
      .catch((e) => setErr(String(e)));
  };
  useEffect(() => { reload(); }, []);
  // 自动刷新：5s 轮询 gateway_log_history，卸载或关闸即清
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [auto]);

  const eps = useMemo(() => [...new Set((logs || []).map((l) => l.ep))].sort(), [logs]);
  const filtered = useMemo(() => {
    let v = logs || [];
    if (epFilter) v = v.filter((l) => l.ep === epFilter);
    if (okFilter === "ok") v = v.filter((l) => l.ok);
    if (okFilter === "fail") v = v.filter((l) => !l.ok);
    return v;
  }, [logs, epFilter, okFilter]);

  const stats = useMemo(() => {
    const v = filtered;
    const ok = v.filter((l) => l.ok).length;
    const mss = v.map((l) => l.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
    const p95 = mss.length ? mss[Math.min(mss.length - 1, Math.floor(mss.length * 0.95))] : null;
    return { total: v.length, ok, fail: v.length - ok, p95 };
  }, [filtered]);

  return (
    <>
      <header className="topbar">
        <div className="wordmark">Gateway<span className="ver"> / {t("xl.title")}</span></div>
      </header>
      <section className="toolbar">
        <button className="btn-ghost has-ic" onClick={reload}><Ic name="refresh" size={15} /> {t("xl.reload")}</button>
        <button className={"btn-ghost has-ic" + (auto ? " x-btn-on" : "")} onClick={() => setAuto(!auto)}><Ic name="refresh" size={15} /> {t("xl.autoRefresh")}</button>
        <span className="tb-spacer" />
      </section>
      <section className="settings open">
        <div className="x-ls-stats">
          <div className="x-stat"><span className="x-stat-v">{stats.total}</span><span className="x-stat-k">{t("xl.total")}</span></div>
          <div className="x-stat"><span className="x-stat-v ok">{stats.ok}</span><span className="x-stat-k">{t("xl.ok")}</span></div>
          <div className="x-stat"><span className="x-stat-v fail">{stats.fail}</span><span className="x-stat-k">{t("xl.fail")}</span></div>
          {stats.p95 != null
            ? <div className="x-stat"><span className="x-stat-v">{stats.p95}<small>ms</small></span><span className="x-stat-k">p95</span></div>
            : null}
        </div>

        <div className="x-ls-filters">
          <select className="zcode-path" value={epFilter} onChange={(e) => setEpFilter(e.target.value)}>
            <option value="">{t("xl.allEps")}</option>
            {eps.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select className="zcode-path" value={okFilter} onChange={(e) => setOkFilter(e.target.value)}>
            <option value="">{t("xl.allStatus")}</option>
            <option value="ok">{t("xl.ok")}</option>
            <option value="fail">{t("xl.fail")}</option>
          </select>
        </div>

        {err
          ? <div className="hint" style={{ color: "var(--red)" }}>{err}</div>
          : filtered.length
            ? <div className="x-log-list">
                <div className="x-log-head">
                  <span>{t("x.logColTs")}</span>
                  <span>{t("x.logColEp")}</span>
                  <span>{t("x.logColAcct")}</span>
                  <span>{t("x.logColModel")}</span>
                  <span>{t("x.logColMs")}</span>
                  <span>{t("x.logColTok")}</span>
                  <span>{t("x.logColCache")}</span>
                  <span>{t("x.logColCode")}</span>
                </div>
                {filtered.slice().reverse().map((l, i) => <LogRow key={i} l={l} />)}
              </div>
            : <div className="x-log-empty">
                <Ic name="empty" size={18} />
                <span>{t("xl.empty")}</span>
              </div>}
        <div className="hint">{t("xl.hint")}</div>
      </section>
    </>
  );
}
