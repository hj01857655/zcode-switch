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
// 正文提取：OpenAI JSON 取 message.content；SSE 逐帧拼 delta；Anthropic 取 content[0].text；都不是就原样
const fmtText = (s) => {
  if (!s) return "";
  const t0 = String(s).trim();
  if (t0.startsWith("data:") || t0.includes("\ndata:")) {
    let out = "";
    for (const line of t0.split("\n")) {
      const d = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!d || d === "[DONE]") continue;
      try {
        const v = JSON.parse(d);
        out += v?.choices?.[0]?.delta?.content ?? v?.choices?.[0]?.message?.content ?? v?.delta?.text ?? "";
      } catch { /* 非 JSON 帧跳过 */ }
    }
    if (out) return out;
  }
  try {
    const v = JSON.parse(t0);
    return v?.choices?.[0]?.message?.content ?? v?.content?.[0]?.text ?? "";
  } catch { return s; }
};

// 请求/响应块：原文 / JSON / 正文 / SSE 四视图切换（req 无正文档；SSE 档把事件流拆成可读行），复制按钮复制当前视图
function LogBlock({ label, raw, resp }) {
  const isJson = useMemo(() => { try { JSON.parse(String(raw).trim()); return true; } catch { return false; } }, [raw]);
  const isSse = useMemo(() => /^\s*event:|^\s*data: /m.test(String(raw)), [raw]);
  // 默认档：能解析就用 JSON，否则落原文
  const [fmt, setFmt] = useState(isJson ? "json" : "raw");
  const opts = [
    ["raw", t("x.fmtRaw")],
    ...(isJson ? [["json", "JSON"]] : []),
    ...(resp ? [["text", t("x.fmtText")]] : []),
    ...(isSse ? [["sse", t("x.fmtSse")]] : []),
  ];
  const view = fmt === "json" ? prettyJson(raw) : fmt === "text" ? fmtText(raw) : fmt === "sse" ? sseFlat(raw) : String(raw);
  return (
    <div className="x-log-block">
      <div className="x-log-block-head">
        <span>{label}</span>
        <span className="x-fmt-seg">
          {opts.map(([k, lab]) => (
            <button key={k} className={fmt === k ? "on" : ""}
              onClick={(e) => { e.stopPropagation(); setFmt(k); }}>{lab}</button>
          ))}
        </span>
        <button className="btn-ghost x-log-copy"
          onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(view).catch(() => {}); }}>
          {t("x.copyBtn")}
        </button>
      </div>
      <pre className={"x-log-pre" + (fmt === "text" ? " x-log-pre-text" : "")}>{view}</pre>
    </div>
  );
}
// SSE 事件流拍平：每个 data: 帧一行摘要（event 类型 + 帧内 JSON 关键字段），跳过 ping/心跳
const sseFlat = (s) => String(s).split("\n").filter((l) => l.startsWith("data: ")).map((l) => {
  const d = l.slice(6).trim();
  try {
    const v = JSON.parse(d);
    const type = v?.type ?? v?.event ?? "?";
    const bits = [];
    if (v?.delta?.text) bits.push(`text:${v.delta.text}`);
    if (v?.delta?.thinking) bits.push(`think:${v.delta.thinking}`);
    if (v?.delta?.stop_reason) bits.push(`stop:${v.delta.stop_reason}`);
    const u = v?.usage ?? v?.message?.usage;
    if (u) bits.push(`in:${u.input_tokens ?? 0} out:${u.output_tokens ?? 0} cr:${u.cache_read_input_tokens ?? 0} cw:${u.cache_creation_input_tokens ?? 0}`);
    return `[${type}]${bits.length ? " " + bits.join(" | ") : ""}`;
  } catch { return `[raw] ${d.slice(0, 120)}`; }
}).join("\n");

// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));

function LogRow({ l }) {
  const [open, setOpen] = useState(false);
  const hasDetail = l.model != null || l.ms != null || l.err != null || l.attempt != null || l.stream != null;
  return (
    <div className={"x-log-item" + (hasDetail && open ? " expanded" : "")}>
      <div className={"x-log-row" + (hasDetail ? " clickable" : "")} onClick={() => hasDetail && setOpen(!open)}>
        <span className={"x-log-caret" + (hasDetail ? (open ? " open" : "") : " none")}>▸</span>
        <span className="x-log-ts" title={new Date(l.ts).toLocaleString()}>{relTime(l.ts)}</span>
        <span className="x-log-ep">
          <span className={"x-log-method" + (epMethod(l.ep) === "GET" ? " get" : "")}>{epMethod(l.ep)}</span>
          <span className="x-log-path">{epPath(l.ep)}</span>
        </span>
        <span className="x-log-acct" title={l.account}>{l.account ?? "—"}</span>
        <span className="x-log-model">{l.model ?? "—"}</span>
        <span className={"x-log-ms" + msTier(l.ms)} title={l.ttft != null ? `TTFT ${l.ttft}ms` : undefined}>{l.ms != null ? (l.stream && l.ttft != null ? `${l.ttft}/${l.ms}ms` : `${l.ms}ms`) : "—"}</span>
        <span className="x-log-tok" title={`${t("x.tokOut")} ${l.tout ?? 0} · ${t("x.tokIn")} ${l.tin ?? 0}`}>{(!l.tin && !l.tout) ? "—" : `${fmtTok(l.tout || 0)}↑/${fmtTok(l.tin || 0)}↓`}</span>
        <span className="x-log-cache" title={`${t("x.tokCacheR")} ${l.tcr ?? 0} · ${t("x.tokCacheW")} ${l.tcw ?? 0}`}>{(l.tcr || l.tcw) ? `${fmtTok(l.tcr || 0)}+${fmtTok(l.tcw || 0)}` : "—"}</span>
        <span className="x-log-stream">{l.stream != null ? (l.stream ? t("x.stream") : t("x.nonStream")) : "—"}</span>
        <span className={"x-log-code " + (l.ok ? stTier(l.status) : " bad")}>
          <span className="x-log-dot" />{l.status}
        </span>
      </div>
      {hasDetail && open
        ? <div className="x-log-detail" onClick={(e) => e.stopPropagation()}>
            <div className="x-log-meta">
              <div className="x-log-tokens">
                <span className="x-tok"><Ic name="tokIn" size={11} /> {t("x.tokIn")} {l.tin ?? 0}</span>
                <span className="x-tok"><Ic name="tokOut" size={11} /> {t("x.tokOut")} {l.tout ?? 0}</span>
                <span className={"x-tok" + ((l.tcr ?? 0) > 0 ? " hit" : "")}><Ic name="bolt" size={11} /> {t("x.tokCacheR")} {l.tcr ?? 0}</span>
                <span className={"x-tok" + ((l.tcw ?? 0) > 0 ? " hit" : "")}><Ic name="pen" size={11} /> {t("x.tokCacheW")} {l.tcw ?? 0}</span>
                <span className="x-tok"><Ic name="clock" size={11} /> {l.ms != null ? `${l.ms}ms` : "—"}</span>
                {l.ttft != null ? <span className="x-tok" title="TTFT">⚡{l.ttft}ms</span> : null}
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
              <span className="x-log-k">{t("x.logColCode")}</span><span className={"x-log-v " + (l.ok ? "ok" : "fail")}>{l.status}{l.req_id ? <small style={{ marginLeft: 6, color: "var(--ink-mute)" }}>{l.req_id.slice(0, 8)}</small> : null}</span>
            </div>
            {l.err ? <div className="x-log-err">{l.err}</div> : null}
            <div className="x-log-blocks">
            {["req", "resp"].filter((k) => l[k]).map((k) => (
              <LogBlock key={k} resp={k === "resp"} raw={l[k]}
                label={k === "req" ? `${t("x.logReq")} · ${l.ep || ""}` : `${t("x.logResp")} · ${l.status ?? ""}`} />
            ))}
            </div>
          </div>
        : null}
    </div>
  );
}

export default function GatewayLogsPage() {
  const [logs, setLogs] = useState(null);
  const [err, setErr] = useState("");
  const [epFilter, setEpFilter] = useState("");
  const [okFilter, setOkFilter] = useState(""); // "" | "ok" | "fail"
  // 自由搜索：端点/账号/模型三字段模糊匹配
  const [q, setQ] = useState("");
  // 相对时间保鲜：30s 一次强制重渲染，让「N 秒前」不僵死
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 30000);
    return () => clearInterval(id);
  }, []);
  // 自动刷新偏好持久化：localStorage（与主题同模式），进页面恢复上次的开关状态
  const [auto, setAuto] = useState(() => localStorage.getItem("zcs-gwlog-auto") === "1");
  const toggleAuto = () => {
    const next = !auto;
    setAuto(next);
    localStorage.setItem("zcs-gwlog-auto", next ? "1" : "0");
  };
  // 日志落盘开关：真值从网关状态读，切换走 gateway_start 的部分更新（只传 logToDisk）
  const [logDisk, setLogDisk] = useState(null);
  useEffect(() => {
    invoke("gateway_status").then((s) => setLogDisk(s?.logToDisk !== false)).catch(() => {});
  }, []);
  const toggleLogDisk = () => {
    const next = !logDisk;
    setLogDisk(next);
    invoke("gateway_start", { logToDisk: next }).catch(() => setLogDisk(!next));
  };

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
    const needle = q.trim().toLowerCase();
    if (needle) v = v.filter((l) => `${l.ep} ${l.account ?? ""} ${l.model ?? ""}`.toLowerCase().includes(needle));
    return v;
  }, [logs, epFilter, okFilter, q]);

  const stats = useMemo(() => {
    const v = filtered;
    const ok = v.filter((l) => l.ok).length;
    // 延迟口径：分位数而非均值（业界惯例，均值被长尾拉偏）；TTFT 仅统计流式行
    const mss = v.map((l) => l.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
    const ttfts = v.filter((l) => l.stream && typeof l.ttft === "number").map((l) => l.ttft).sort((a, b) => a - b);
    const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
    const sum = (k) => v.reduce((a, l) => a + (l[k] || 0), 0);
    return {
      total: v.length, ok, fail: v.length - ok,
      rate: v.length ? Math.round((ok / v.length) * 100) : null,
      msP50: pct(mss, 0.5), msP95: pct(mss, 0.95),
      ttftP50: pct(ttfts, 0.5), ttftP95: pct(ttfts, 0.95),
      tin: sum("tin"), tout: sum("tout"), tcache: sum("tcr") + sum("tcw"),
    };
  }, [filtered]);

  // 导出当前筛选结果为 JSON 文件
  const exportLogs = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gateway-logs-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <header className="topbar">
        <div className="wordmark">Gateway<span className="ver"> / {t("xl.title")}</span></div>
      </header>
      <section className="toolbar">
        <button className="btn-ghost has-ic" onClick={reload}><Ic name="refresh" size={15} /> {t("xl.reload")}</button>
        <button className={"tog-inline" + (auto ? " on" : "")} role="switch" aria-checked={auto}
          onClick={toggleAuto}>
          <span className={"toggle" + (auto ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
          {t("xl.autoRefresh")}
        </button>
        <button className={"tog-inline" + (logDisk ? " on" : "")} role="switch" aria-checked={!!logDisk}
          disabled={logDisk == null} onClick={toggleLogDisk}>
          <span className={"toggle" + (logDisk ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
          {t("x.tuneLogDisk")}
        </button>
        <button className="btn-ghost has-ic" onClick={exportLogs}><Ic name="exportAll" size={15} /> {t("xl.export")}</button>
        <span className="tb-spacer" />
      </section>
      <section className="settings open">
        <div className="x-ls-stats">
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("xl.groupReq")}</span>
            <div className="x-stat"><span className="x-stat-v">{stats.total}</span><span className="x-stat-k">{t("xl.total")}</span></div>
            <div className="x-stat"><span className="x-stat-v ok">{stats.ok}</span><span className="x-stat-k">{t("xl.ok")}</span></div>
            <div className="x-stat"><span className="x-stat-v fail">{stats.fail}</span><span className="x-stat-k">{t("xl.fail")}</span></div>
            {stats.rate != null
              ? <div className="x-stat"><span className="x-stat-v">{stats.rate}<small>%</small></span><span className="x-stat-k">{t("xl.rate")}</span></div>
              : null}
          </div>
          {stats.msP50 != null || stats.ttftP50 != null
            ? <div className="x-ls-group">
                <span className="x-ls-group-label">{t("xl.groupLat")}</span>
                {stats.msP50 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.msP50}<small>ms</small></span><span className="x-stat-k" title={t("xl.latTotal")}>p50</span></div>
                  : null}
                {stats.msP95 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.msP95}<small>ms</small></span><span className="x-stat-k" title={t("xl.latTotal")}>p95</span></div>
                  : null}
                {stats.ttftP50 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP50}<small>ms</small></span><span className="x-stat-k" title="Time To First Token (stream, p50)">TTFT p50</span></div>
                  : null}
                {stats.ttftP95 != null
                  ? <div className="x-stat"><span className="x-stat-v">{stats.ttftP95}<small>ms</small></span><span className="x-stat-k" title="Time To First Token (stream, p95)">TTFT p95</span></div>
                  : null}
              </div>
            : null}
          <div className="x-ls-group">
            <span className="x-ls-group-label">{t("xl.groupTok")}</span>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tin)}<small>↓</small></span><span className="x-stat-k">{t("x.tokIn")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tout)}<small>↑</small></span><span className="x-stat-k">{t("x.tokOut")}</span></div>
            <div className="x-stat"><span className="x-stat-v">{fmtTok(stats.tcache)}<small>⚡</small></span><span className="x-stat-k">{t("x.tokCache")}</span></div>
          </div>
        </div>

        <div className="x-ls-filters">
          <input className="zcode-path x-ls-search" type="text" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder={t("xl.searchPh")} />
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
                  <span></span>
                  <span>{t("x.logColTs")}</span>
                  <span>{t("x.logColEp")}</span>
                  <span>{t("x.logColAcct")}</span>
                  <span>{t("x.logColModel")}</span>
                  <span>{t("x.logColMs")}</span>
                  <span>{t("x.logColTok")}</span>
                  <span>{t("x.logColCache")}</span>
                  <span>{t("x.logColStream")}</span>
                  <span>{t("x.logColCode")}</span>
                </div>
                {filtered.slice().reverse().map((l) => <LogRow key={`${l.ts}|${l.ep}|${l.account}`} l={l} />)}
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
