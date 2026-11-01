// React 版 Gateway 页：反代服务控制面板（M1 接线 gateway_start/stop/status）
// 布局与设置页同构（靠左表单流 .settings），状态区置顶。
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { toast } from "../components/ui-bus.js";
import { Ic } from "../components/iconsx.jsx";

// 日志行：八列网格；点行展开结构化详情（字段键值 + 错误块），复制 JSON 为角落次要操作
// 行视觉：相对时间（悬浮显绝对）、方法徽章、状态点、耗时分档 —— 与日志页同构
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
// 从响应 JSON 里抽取纯文本内容（OpenAI responses / chat / anthropic messages 三种形态）
const fmtText = (s) => {
  let v;
  try { v = JSON.parse(s); } catch { return s; }
  const out = v?.output;
  if (Array.isArray(out)) {
    const parts = out.flatMap((o) => (Array.isArray(o?.content) ? o.content : [])).map((c) => c?.text).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  const chat = v?.choices?.[0]?.message?.content;
  if (typeof chat === "string") return chat;
  const ant = v?.content;
  if (Array.isArray(ant)) {
    const parts = ant.map((c) => c?.text).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return s;
};
// SSE 事件流拍平：每个 data: 帧一行摘要（event 类型 + 帧内 JSON 关键字段）
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

// 请求/响应块：原文 / JSON / 正文 / SSE 四视图切换（req 无正文档；SSE 档把事件流拆成可读行），复制按钮复制当前视图
function LogBlock({ label, raw, resp }) {
  const isJson = useMemo(() => { try { JSON.parse(String(raw).trim()); return true; } catch { return false; } }, [raw]);
  const isSse = useMemo(() => /^\s*event:|^\s*data: /m.test(String(raw)), [raw]);
  const [fmt, setFmt] = useState("raw");
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
// token 紧凑格式：>=1000 显示 k（一位小数，整 k 去尾），<1000 原样
const fmtTok = (n) => (n >= 1000 ? (n % 1000 === 0 ? `${n / 1000}k` : `${(n / 1000).toFixed(1)}k`) : String(n));

// 端点输入即配置：host 固定本机，端口从 URL 解析（省略端口 = 默认 8081）；解析失败返回 null
const parseEndpoint = (s) => {
  try {
    const u = new URL(s.trim());
    if ((u.protocol !== "http:" && u.protocol !== "https:")
      || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return null;
    const p = u.port ? parseInt(u.port, 10) : 8081;
    return (Number.isFinite(p) && p > 0 && p <= 65535) ? p : null;
  } catch { return null; }
};

function LogRow({ l }) {
  const [open, setOpen] = useState(false);
  const hasDetail = l.model != null || l.ms != null || l.err != null || l.attempt != null || l.stream != null || l.req != null || l.resp != null;
  return (
    <div className={"x-log-item" + (hasDetail && open ? " expanded" : "")}>
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
        <span className="x-log-stream">{l.stream != null ? (l.stream ? t("x.stream") : t("x.nonStream")) : "—"}</span>
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
            <div className="x-log-blocks">
            {["req", "resp"].filter((k) => l[k]).map((k) => (
              <LogBlock key={k} resp={k === "resp"} raw={l[k]}
                label={k === "req" ? t("x.logReq") : t("x.logResp")} />
            ))}
            </div>
            {l.err ? <div className="x-log-err">{l.err}</div> : null}
          </div>
        : null}
    </div>
  );
}

export default function GatewayPage({ onOpenLogs }) {
  const [status, setStatus] = useState(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  // 调优项（端口/密钥/超时/重试/退避/CORS/体积上限/日志/sticky）收进「配置」对话框，页面只留端点概览
  const [tuneOpen, setTuneOpen] = useState(false);
  // 测试请求弹窗：选模型、填消息、发真请求、看结果
  const [testOpen, setTestOpen] = useState(false);
  const [testModel, setTestModel] = useState("");
  const [testMsg, setTestMsg] = useState("hi");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [connectInput, setConnectInput] = useState("");
  const [retriesInput, setRetriesInput] = useState("");
  const [backoffInput, setBackoffInput] = useState("");
  const [corsInput, setCorsInput] = useState("");
  const [bodyLimitInput, setBodyLimitInput] = useState("");
  const [logDiskInput, setLogDiskInput] = useState(true);
  const [logMaxInput, setLogMaxInput] = useState("");
  const [stickyInput, setStickyInput] = useState(true);
  // 用户是否动过 key/端点输入框：没动过就跟随盘上真值（启动/换号后 key 会变），动过则尊重输入
  const keyTouched = useRef(false);
  const epTouched = useRef(false);
  // 配置对话框开着时不让轮询把开关草稿刷回盘上值
  const tuneOpenRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    const key = status?.apiKey || "";
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
    } catch {
      // WebView2 剪贴板 API 不可用时退回 execCommand
      const ta = document.createElement("textarea");
      ta.value = key;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const refresh = async () => {
    try {
      const s = await invoke("gateway_status");
      setStatus(s);
      // 用户没动过输入框时跟随盘上真值（启动/换号后 key 会变）
      if (!keyTouched.current) setApiKey(s?.apiKey || "");
      if (!epTouched.current) setEndpointInput(`http://127.0.0.1:${s?.port ?? 8081}/v1`);
      setConnectInput((v) => v || String(s?.upstreamConnectSecs ?? ""));
      setRetriesInput((v) => v || String(s?.maxRetries ?? ""));
      setBackoffInput((v) => v || String(s?.globalBackoffSecs ?? ""));
      setCorsInput((v) => v || (s?.corsOrigins || []).join(", "));
      setBodyLimitInput((v) => v || String(s?.bodyLimitMb ?? ""));
      setLogMaxInput((v) => v || String(s?.logFileMaxMb ?? ""));
      if (!tuneOpenRef.current) {
        setLogDiskInput(s?.logToDisk !== false);
        setStickyInput(s?.sticky !== false);
      }
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), 2000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { tuneOpenRef.current = tuneOpen; }, [tuneOpen]);

  const running = status?.running ?? false;
  // 端点输入解析出的端口与盘上不一致 = 待保存；解析失败不给保存
  const parsedPort = parseEndpoint(endpointInput);
  const portDirty = status != null && parsedPort != null && parsedPort !== status.port;
  const keyDirty = keyTouched.current && apiKey.trim() !== (status?.apiKey || "");
  const tuneDirty = status != null && (
    String(status.upstreamConnectSecs ?? "") !== connectInput.trim() ||
    String(status.maxRetries ?? "") !== retriesInput.trim() ||
    String(status.globalBackoffSecs ?? "") !== backoffInput.trim() ||
    (status.corsOrigins || []).join(", ") !== corsInput.trim() ||
    String(status.bodyLimitMb ?? "") !== bodyLimitInput.trim() ||
    status.logToDisk !== logDiskInput ||
    String(status.logFileMaxMb ?? "") !== logMaxInput.trim() ||
    status.sticky !== stickyInput
  );
  const guard = async (fn) => {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const doStart = () => guard(async () => {
    await invoke("gateway_start", { port: null, apiKey: null });
  });
  // 页面上的基础保存：端口（从端点 URL 解析）+ 密钥一起落盘，调优沿用盘上值
  const doSaveBase = () => guard(async () => {
    const p = parseEndpoint(endpointInput);
    if (p == null) throw new Error(t("x.badPort"));
    await invoke("gateway_start", { port: p, apiKey: apiKey.trim() || null });
    keyTouched.current = false;
    epTouched.current = false;
    setEndpointInput(`http://127.0.0.1:${p}/v1`);
    setApiKey(status?.apiKey || apiKey.trim());
  });
  // 配置对话框保存：只写调优项，端口/密钥传 null 沿用盘上值
  const doSaveTune = () => guard(async () => {
    const conn = parseInt(connectInput.trim(), 10);
    const ret = parseInt(retriesInput.trim(), 10);
    const back = parseInt(backoffInput.trim(), 10);
    const bl = parseInt(bodyLimitInput.trim(), 10);
    const lm = parseInt(logMaxInput.trim(), 10);
    await invoke("gateway_start", {
      port: null,
      apiKey: null,
      upstreamConnectSecs: Number.isFinite(conn) && conn > 0 ? conn : null,
      maxRetries: Number.isFinite(ret) && ret >= 0 ? ret : null,
      globalBackoffSecs: Number.isFinite(back) && back > 0 ? back : null,
      corsOrigins: corsInput.trim() ? corsInput.split(",").map((s) => s.trim()).filter(Boolean) : null,
      bodyLimitMb: Number.isFinite(bl) && bl > 0 ? bl : null,
      logToDisk: logDiskInput,
      logFileMaxMb: Number.isFinite(lm) && lm > 0 ? lm : null,
      sticky: stickyInput,
    });
    setTuneOpen(false);
  });
  const doStop = () => guard(async () => {
    await invoke("gateway_stop");
  });
  // 页面内自测：直接打本地网关，结果 toast 直读（CSP connect-src 已放行 127.0.0.1）
  // 测试请求弹窗发送：真调 /v1/chat/completions，结果留在弹窗里看
  const doTestSend = () => guard(async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const t0 = Date.now();
      const r = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey || status?.apiKey || ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: testModel, messages: [{ role: "user", content: testMsg || "hi" }], max_tokens: 256 }),
      });
      const body = await r.json().catch(() => ({}));
      const text = r.ok
        ? (body?.choices?.[0]?.message?.content || JSON.stringify(body).slice(0, 400))
        : (body?.error?.message || JSON.stringify(body).slice(0, 300));
      setTestResult({ ok: r.ok, status: r.status, ms: Date.now() - t0, text: String(text) });
    } finally {
      setTestBusy(false);
    }
  });

  const endpoint = `http://127.0.0.1:${status?.port ?? 8081}/v1`;
  const curlSample =
    `curl ${endpoint}/chat/completions \\\n` +
    `  -H "Authorization: Bearer <API_KEY>" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'`;

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          Gateway{status ? <span className="ver">: {running ? t("x.running") : t("x.stopped")}</span> : null}
        </div>
        <div className="top-status">
          <span className={"status-dot " + (running ? "run" : "off")} />
          <span className="status-text">{running ? t("x.running") : t("x.stopped")}</span>
        </div>
      </header>
      <section className="toolbar">
        {running
          ? <button className="btn-ghost has-ic" disabled={busy} onClick={doStop}><Ic name="power" size={15} /> {t("x.stop")}</button>
          : <button className="btn-primary has-ic" disabled={busy} onClick={doStart}><Ic name="play" size={15} /> {t("x.start")}</button>}
        <button className="btn-ghost has-ic" disabled={busy || !running}
          onClick={() => { setTestModel((v) => v || (status?.models || [])[0] || "GLM-5.3-Flash"); setTestOpen(true); }}><Ic name="capture" size={15} /> {t("x.testBtn")}</button>
        {onOpenLogs
          ? <button className="btn-ghost has-ic" onClick={onOpenLogs}><Ic name="list" size={15} /> {t("xl.menuLabel")}</button>
          : null}
        <span className="tb-spacer" />
      </section>
      <section className="settings open gw-page">
        <label>{t("x.endpointLabel")}</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={endpointInput}
            onChange={(e) => { epTouched.current = true; setEndpointInput(e.target.value); }}
            placeholder="http://127.0.0.1:8081/v1" />
          {portDirty
            ? <button className="btn-ghost" disabled={running || busy} onClick={doSaveBase}>{t("common.save")}</button>
            : null}
          <button className="btn-ghost" onClick={() => setTuneOpen(true)}>{t("x.cfgBtn")}</button>
        </div>

        <label style={{ marginTop: 10 }}>API KEY</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={apiKey}
            onChange={(e) => { keyTouched.current = true; setApiKey(e.target.value); }}
            placeholder={t("x.apiKeyPh")} />
          {status?.apiKey
            ? <button className="btn-ghost" onClick={copyKey}>{copied ? t("x.copied") : t("x.copyKey")}</button>
            : null}
          {keyDirty
            ? <button className="btn-ghost" disabled={running || busy} onClick={doSaveBase}>{t("common.save")}</button>
            : null}
        </div>
        {running && (keyDirty || portDirty) ? <div className="hint">{t("x.cfgRunningHint")}</div> : null}

        <div className="gw-cols">
          <div className="gw-col">
            <label>{t("x.poolLabel")}</label>
            {status?.pool?.members?.length
              ? <div className="x-pool">
                  {status.pool.members.map((m) => (
                    <div className="x-pool-row" key={m.id}>
                      <span className={"x-pool-dot" + (m.cooldown_secs > 0 ? " cool" : m.inflight > 0 ? " busy" : "")} />
                      <span className="x-pool-name" title={m.id}>{m.name}</span>
                      {m.inflight > 0 ? <span className="x-pool-tag">{t("x.inflight")} {m.inflight}</span> : null}
                      {m.cooldown_secs > 0
                        ? <span className="x-pool-tag warn">{t("x.cooldown")} {m.cooldown_secs}s</span>
                        : null}
                    </div>
                  ))}
                  {status.pool.global_backoff_secs > 0
                    ? <div className="x-pool-global warn">{t("x.globalBackoff")} {status.pool.global_backoff_secs}s</div>
                    : null}
                  <div className="x-pool-stats">
                    {t("x.poolStats", { ok: status.pool.total_ok ?? 0, err: status.pool.total_err ?? 0 })}
                  </div>
                </div>
              : <div className="x-log-empty"><Ic name="empty" size={16} /><span>{t("x.poolEmpty")}</span></div>}

            <label style={{ marginTop: 14 }}>{t("x.logLabel")}</label>
            {status?.logs?.length ? (() => {
              const logs = status.logs;
              const okN = logs.filter((l) => l.ok).length;
              const ms = logs.filter((l) => l.ms != null).map((l) => l.ms);
              const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
              return (
                <div className="x-farm-stats">
                  {t("x.statsLine", { n: logs.length, ok: okN, err: logs.length - okN })}
                  {avg != null ? <span style={{ marginLeft: 10 }}>{t("x.statsAvg", { ms: avg })}</span> : null}
                </div>
              );
            })() : null}
            {/* 只留内存环摘要：完整历史、筛选与 p95 在独立日志页 */}
            {status?.logs?.length
              ? <div className="x-log-list">
                  <div className="x-log-head">
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
                  {status.logs.slice(-8).reverse().map((l, i) => (
                    <LogRow key={i} l={l} />
                  ))}
                  {onOpenLogs
                    ? <button className="btn-ghost x-log-more" onClick={onOpenLogs}>{t("xl.menuLabel")} →</button>
                    : null}
                </div>
              : <div className="x-log-empty">
                  <Ic name="empty" size={18} />
                  <span>{t("x.logEmpty")}</span>
                </div>}
          </div>

          <div className="gw-col">
            <label>{t("x.protoLabel")}</label>
            <div className="x-pool">
              <div className="x-pool-row"><span className="x-proto-ep">POST /v1/chat/completions</span><span className="x-pool-tag">{t("x.protoOpenAI")}</span></div>
              <div className="x-pool-row"><span className="x-proto-ep">POST /v1/messages</span><span className="x-pool-tag">{t("x.protoAnthropic")}</span></div>
              <div className="x-pool-row"><span className="x-proto-ep">POST /v1/responses</span><span className="x-pool-tag">{t("x.protoResponses")}</span></div>
              <div className="x-pool-row"><span className="x-proto-ep">GET&nbsp; /v1/models</span><span className="x-pool-tag">{t("x.protoModels")}</span></div>
            </div>

            <label style={{ marginTop: 14 }}>MODELS</label>
            <div className="x-pool">
              {(status?.models?.length ? status.models : []).map((m) => (
                <div className="x-pool-row" key={m}><span className="x-proto-ep">{m}</span></div>
              ))}
              {!status?.models?.length
                ? <div className="x-pool-row"><span className="x-proto-ep" style={{ color: "var(--ink-mute)" }}>…</span></div>
                : null}
            </div>

            <label style={{ marginTop: 14 }}>{t("x.exampleLabel")}</label>
            <pre className="x-curl">{curlSample}</pre>
            <div className="hint">{t("x.endpointDesc")}</div>
            {err ? <div className="hint" style={{ color: "var(--red)" }}>{err}</div> : null}
          </div>
        </div>
      </section>

      {tuneOpen
        ? <div className="pv-mask" onClick={() => setTuneOpen(false)}>
            <div className="pv-panel x-tune-panel" onClick={(e) => e.stopPropagation()}>
              <div className="pv-title">{t("x.cfgTitle")}</div>
              <div className="pv-sub">{t("x.tuneHint")}</div>
              <label>{t("x.tuneLabel")}</label>
              <div className="x-tune">
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneConnect")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={connectInput}
                    onChange={(e) => setConnectInput(e.target.value)} placeholder="15" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneRetries")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={retriesInput}
                    onChange={(e) => setRetriesInput(e.target.value)} placeholder="1" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneBackoff")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={backoffInput}
                    onChange={(e) => setBackoffInput(e.target.value)} placeholder="600" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneCors")}</span>
                  <input className="zcode-path" type="text" value={corsInput}
                    onChange={(e) => setCorsInput(e.target.value)} placeholder="https://a.example, https://b.example | * 放行全部" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneBodyLimit")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={bodyLimitInput}
                    onChange={(e) => setBodyLimitInput(e.target.value)} placeholder="32" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneLogMax")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={logMaxInput}
                    onChange={(e) => setLogMaxInput(e.target.value)} placeholder="16" />
                </div>
                <div className="x-tune-switch">
                  <div className="x-tune-item">
                    <span className="x-tune-name">{t("x.tuneLogDisk")}</span>
                    <button className={"tog-inline" + (logDiskInput ? " on" : "")} role="switch" aria-checked={logDiskInput}
                      onClick={() => setLogDiskInput(!logDiskInput)}>
                      <span className={"toggle" + (logDiskInput ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
                      {logDiskInput ? t("x.tuneLogOn") : t("x.tuneLogOff")}
                    </button>
                  </div>
                  <div className="x-tune-item">
                    <span className="x-tune-name">{t("x.tuneSticky")}</span>
                    <button className={"tog-inline" + (stickyInput ? " on" : "")} role="switch" aria-checked={stickyInput}
                      onClick={() => setStickyInput(!stickyInput)}>
                      <span className={"toggle" + (stickyInput ? " on" : "")} aria-hidden="true"><span className="knob" /></span>
                      {stickyInput ? t("x.stickyOn") : t("x.stickyOff")}
                    </button>
                  </div>
                </div>
              </div>
              <div className="pv-actions">
                <button className="btn-ghost" onClick={() => setTuneOpen(false)}>{t("common.cancel")}</button>
                <button className="btn-ghost" disabled={!tuneDirty || busy} onClick={() => guard(doSaveTune)}>
                  {t("common.save")}
                </button>
              </div>
            </div>
          </div>
        : null}

      {testOpen
        ? <div className="pv-mask" onClick={() => setTestOpen(false)}>
            <div className="pv-panel x-test-panel" onClick={(e) => e.stopPropagation()}>
              <div className="pv-title">{t("x.testTitle")}</div>
              <div className="pv-sub">{t("x.testHint")}</div>
              <label>{t("x.testModel")}</label>
              <select className="zcode-path" value={testModel}
                onChange={(e) => setTestModel(e.target.value)}>
                {(status?.models || [testModel]).filter(Boolean).map((m) =>
                  <option key={m} value={m}>{m}</option>)}
              </select>
              <label style={{ marginTop: 10 }}>{t("x.testMsg")}</label>
              <textarea className="zcode-path x-test-msg" value={testMsg}
                onChange={(e) => setTestMsg(e.target.value)} rows={3} />
              <div className="pv-actions" style={{ justifyContent: "flex-start" }}>
                <button className="btn-ghost has-ic" disabled={testBusy || !running} onClick={() => guard(doTestSend)}>
                  {testBusy ? t("x.testSending") : t("x.testSend")}
                </button>
                <button className="btn-ghost" onClick={() => setTestOpen(false)}>{t("common.cancel")}</button>
              </div>
              {testResult
                ? <>
                    <label style={{ marginTop: 10 }}>{t("x.testResult")}</label>
                    <div className={"x-test-out" + (testResult.ok ? "" : " bad")}>
                      <div className="x-test-meta">
                        <span className={"dot " + (testResult.ok ? "ok" : "bad")} />
                        HTTP {testResult.status} · {testResult.ms}ms
                      </div>
                      <div className="x-test-text">{testResult.text}</div>
                    </div>
                  </>
                : null}
            </div>
          </div>
        : null}
    </>
  );
}
