// React 版 Gateway 页：反代服务控制面板（M1 接线 gateway_start/stop/status）
// 布局与设置页同构（靠左表单流 .settings），状态区置顶。
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { toast } from "../components/ui-bus.js";
import { Ic } from "../components/iconsx.jsx";

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

export default function GatewayPage({ onOpenLogs, onOpenAccount }) {
  const [status, setStatus] = useState(null);
  const [endpointInput, setEndpointInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  // 调优项（端口/密钥/超时/重试/退避/CORS/体积上限/日志/sticky）收进「配置」对话框，页面只留端点概览
  const [tuneOpen, setTuneOpen] = useState(false);
  // 测试请求弹窗：选模型、填消息、发真请求、看结果；历史留痕可回看
  const [testOpen, setTestOpen] = useState(false);
  const [testProto, setTestProto] = useState("openai");
  const [accProto, setAccProto] = useState("openai");
  const [copiedEx, setCopiedEx] = useState(false);
  const [testBody, setTestBody] = useState("");
  const [testShowCode, setTestShowCode] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testHistory, setTestHistory] = useState([]);
  const testAbort = useRef(null);
  const [connectInput, setConnectInput] = useState("");
  const [retriesInput, setRetriesInput] = useState("");
  const [backoffInput, setBackoffInput] = useState("");
  const [corsInput, setCorsInput] = useState("");
  const [bodyLimitInput, setBodyLimitInput] = useState("");
  const [logDiskInput, setLogDiskInput] = useState(true);
  const [logMaxInput, setLogMaxInput] = useState("");
  const [stickyInput, setStickyInput] = useState(true);
  const [failsInput, setFailsInput] = useState("");
  const [keepaliveInput, setKeepaliveInput] = useState("");
  const [timeoutInput, setTimeoutInput] = useState("");
  // 池成员折叠：异常优先展示，正常号超阈值收成计数行，点开全量
  const [poolExpand, setPoolExpand] = useState(false);
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
      setFailsInput((v) => v || String(s?.allowedFails ?? ""));
      setKeepaliveInput((v) => v || String(s?.keepaliveSecs ?? ""));
      setTimeoutInput((v) => v || String(s?.totalTimeoutSecs ?? ""));
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
    status.sticky !== stickyInput ||
    String(status.allowedFails ?? "") !== failsInput.trim() ||
    String(status.keepaliveSecs ?? "") !== keepaliveInput.trim() ||
    String(status.totalTimeoutSecs ?? "") !== timeoutInput.trim()
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
      allowedFails: Number.isFinite(parseInt(failsInput.trim(), 10)) ? Math.max(0, parseInt(failsInput.trim(), 10)) : null,
      keepaliveSecs: Number.isFinite(parseInt(keepaliveInput.trim(), 10)) ? Math.max(0, parseInt(keepaliveInput.trim(), 10)) : null,
      totalTimeoutSecs: Number.isFinite(parseInt(timeoutInput.trim(), 10)) ? Math.max(0, parseInt(timeoutInput.trim(), 10)) : null,
    });
    setTuneOpen(false);
  });
  const doStop = () => guard(async () => {
    await invoke("gateway_stop");
  });
  // 测试弹窗：请求体直接以 JSON 编辑（model/stream/参数全在体里，协议分段只决定端点路径与 anthropic-version 头）
  const defaultTestBody = () => JSON.stringify(
    testProto === "responses"
      ? { model: (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0], input: "hi", max_output_tokens: 256, stream: false }
      : { model: (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0], max_tokens: 256, stream: false, messages: [{ role: "user", content: "hi" }] },
    null, 2);
  let testBodyParsed = {};
  try { testBodyParsed = JSON.parse(testBody || defaultTestBody()); } catch { /* 非法 JSON：curl 预览退空体 */ }
  const doTestSend = () => guard(async () => {
    setTestBusy(true);
    setTestResult(null);
    // 可取消：流式长生成中途能停；AbortError 单独落「已取消」，不进错误 toast
    testAbort.current?.abort();
    const ac = new AbortController();
    testAbort.current = ac;
    const t0 = Date.now();
    try {
      const anthropic = testProto === "anthropic";
      const path = anthropic ? "/messages" : testProto === "responses" ? "/responses" : "/chat/completions";
      let body;
      try {
        body = JSON.parse(testBody || defaultTestBody());
      } catch {
        setTestResult({ ok: false, status: 0, ms: Date.now() - t0, text: t("x.testBadJson"), stream: false, proto: testProto });
        setTestBusy(false);
        return;
      }
      const streaming = body?.stream === true;
      const r = await fetch(`${endpoint}${path}`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Authorization": `Bearer ${apiKey || status?.apiKey || ""}`,
          "Content-Type": "application/json",
          ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
        },
        body: JSON.stringify(body),
      });
      let text = "";
      let usage = null;
      let ttft = null;
      const pullFrame = (d) => {
        if (d === "[DONE]") return;
        try {
          const v = JSON.parse(d);
          if (ttft == null) ttft = Date.now() - t0; // 首帧即 TTFT
          text += (anthropic ? v?.delta?.text : testProto === "responses" ? v?.delta : v?.choices?.[0]?.delta?.content) ?? "";
          // 合并而非覆盖：Anthropic 的 usage 分帧下发（message_start 给 input，message_delta 给 output）
          usage = { ...(usage || {}), ...(v?.usage || {}), ...(v?.response?.usage || {}) };
        } catch { /* 非 JSON 帧跳过 */ }
      };
      if (streaming && r.ok) {
        // 流式：逐帧读 SSE；OpenAI 拼 delta.content，Anthropic 拼 delta.text
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) pullFrame(line.slice(6).trim());
          }
        }
        // 收尾 flush：末尾无换行的残留帧也吃掉，不丢结尾
        if (buf.startsWith("data: ")) pullFrame(buf.slice(6).trim());
      } else {
        const rb = await r.json().catch(() => ({}));
        text = r.ok
          ? (anthropic
              ? (rb?.content?.find?.((b) => b?.type === "text")?.text || responsesText(rb) || JSON.stringify(rb).slice(0, 400))
              : testProto === "responses"
                ? (responsesText(rb) || JSON.stringify(rb).slice(0, 400))
                : (rb?.choices?.[0]?.message?.content || JSON.stringify(rb).slice(0, 400)))
          : (rb?.error?.message || JSON.stringify(rb).slice(0, 300));
        usage = rb?.usage ?? null;
      }
      const tin = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
      const tout = usage?.completion_tokens ?? usage?.output_tokens ?? null;
      const res = { ok: r.ok, status: r.status, ms: Date.now() - t0, text: String(text), stream: streaming, proto: testProto, ttft, usage, tin, tout };
      setTestResult(res);
      setTestHistory((h) => [res, ...h].slice(0, 5));
    } catch (e) {
      if (e?.name === "AbortError") {
        setTestResult({ ok: false, status: 0, ms: Date.now() - t0, text: t("x.testAborted"), stream: false, proto: testProto });
      } else {
        throw e;
      }
    } finally {
      setTestBusy(false);
      testAbort.current = null;
    }
  });

  // Responses 非流式出站取文本：优先 output_text 便捷字段，否则沿 output[].content[].text 拼接
  const responsesText = (rb) => rb?.output_text
    || (Array.isArray(rb?.output)
      ? rb.output.flatMap((o) => (Array.isArray(o?.content) ? o.content.map((c) => c?.text ?? "") : [])).join("")
      : "");

  const endpoint = `http://127.0.0.1:${status?.port ?? 8081}/v1`;
  // 池排序：熔断 > 冷却 > 在飞 > 正常，异常天然排前；展开后全量渲染，折叠时只留前 12 行
  const POOL_SHOWN = 12;
  const poolSorted = useMemo(() => {
    const ms = status?.pool?.members || [];
    const rank = (m) => (m.cooldown_secs >= 600 ? 0 : m.cooldown_secs > 0 ? 1 : m.inflight > 0 ? 2 : 3);
    return [...ms].sort((a, b) => rank(a) - rank(b));
  }, [status]);
  const poolShown = poolExpand ? poolSorted : poolSorted.slice(0, POOL_SHOWN);
  const testCurl =
    `curl ${endpoint}${testProto === "anthropic" ? "/messages" : testProto === "responses" ? "/responses" : "/chat/completions"} \\\n` +
    `  -H "Authorization: Bearer <API_KEY>" \\\n` +
    (testProto === "anthropic" ? `  -H "anthropic-version: 2023-06-01" \\\n` : "") +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '${JSON.stringify(testBodyParsed).replace(/'/g, "'\\''")}'`;
  // 接入示例随协议切换：真实端点 + 真实 key + 盘上真实模型名（key 缺省才落占位符）
  const modelShown = (status?.models?.length ? status.models : ["GLM-5.3-Flash"])[0];
  const keyShown = status?.apiKey || "<API_KEY>";
  const accessCurls =
    accProto === "anthropic"
      ? [`curl ${endpoint}/messages \\\n` +
          `  -H "Authorization: Bearer ${keyShown}" \\\n` +
          `  -H "anthropic-version: 2023-06-01" \\\n` +
          `  -H "Content-Type: application/json" \\\n` +
          `  -d '{"model":"${modelShown}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`]
      : accProto === "models"
        ? [`curl ${endpoint}/models \\\n` +
          `  -H "Authorization: Bearer ${keyShown}"`]
        // OpenAI 一档并列两种协议：Chat Completions 与 Responses
        : [`curl ${endpoint}/chat/completions \\\n` +
            `  -H "Authorization: Bearer ${keyShown}" \\\n` +
            `  -H "Content-Type: application/json" \\\n` +
            `  -d '{"model":"${modelShown}","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'`,
          `curl ${endpoint}/responses \\\n` +
            `  -H "Authorization: Bearer ${keyShown}" \\\n` +
            `  -H "Content-Type: application/json" \\\n` +
            `  -d '{"model":"${modelShown}","input":"hi","max_output_tokens":256}'`];
  const copyExample = async () => {
    try { await navigator.clipboard.writeText(accessCurl); setCopiedEx(true); setTimeout(() => setCopiedEx(false), 1200); } catch { /* noop */ }
  };

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
          onClick={() => setTestOpen(true)}><Ic name="capture" size={15} /> {t("x.testBtn")}</button>
        <button className="btn-ghost has-ic" onClick={() => setTuneOpen(true)}><Ic name="sliders" size={15} /> {t("x.cfgBtn")}</button>
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
                  {/* 默认折叠成一行摘要（业界网关主页不放成员明细），点击展开看每号状态 */}
                  <div className="x-pool-summary" onClick={() => setPoolExpand(!poolExpand)}>
                    {t("x.poolSummary", {
                      n: poolSorted.filter((m) => !(m.cooldown_secs > 0)).length,
                      cool: poolSorted.filter((m) => m.cooldown_secs > 0).length,
                      inflight: poolSorted.reduce((a, m) => a + (m.inflight || 0), 0),
                      total: poolSorted.length,
                    })}
                    <span className={"x-pool-caret" + (poolExpand ? " open" : "")}>▸</span>
                  </div>
                  {poolExpand
                    ? <>
                        {poolShown.map((m) => (
                          <div className="x-pool-row" key={m.id}>
                            <span className={"x-pool-dot" + (m.cooldown_secs > 0 ? " cool" : m.inflight > 0 ? " busy" : "")} />
                            <span className={"x-pool-name" + (onOpenAccount ? " link" : "")} title={m.id}
                              onClick={() => onOpenAccount?.(m.id)}>{m.name}</span>
                            {m.inflight > 0 ? <span className="x-pool-tag">{t("x.inflight")} {m.inflight}</span> : null}
                            {m.cooldown_secs > 0
                              ? <span className={"x-pool-tag" + (m.cooldown_secs >= 600 ? " bad" : " warn")}>{m.cooldown_secs >= 600 ? t("x.poolTripped") : t("x.cooldown")} {m.cooldown_secs}s</span>
                              : null}
                            {m.ok != null
                              ? <span className={"x-pool-tag" + ((m.err ?? 0) > 0 ? " warn" : "")}>{t("x.poolHealth", { ok: m.ok, err: m.err ?? 0 })}</span>
                              : null}
                          </div>
                        ))}
                        {poolSorted.length > POOL_SHOWN
                          ? <div className="x-pool-more" onClick={() => setPoolExpand(!poolExpand)}>
                              {poolExpand ? t("xl.poolLess") : t("xl.poolMore", { n: poolSorted.length - POOL_SHOWN })}
                            </div>
                          : null}
                      </>
                    : null}
                  {status.pool.global_backoff_secs > 0
                    ? <div className="x-pool-global warn">{t("x.globalBackoff")} {status.pool.global_backoff_secs}s</div>
                    : null}
                  <div className="x-pool-stats">
                    {t("x.poolStats", { ok: status.pool.total_ok ?? 0, err: status.pool.total_err ?? 0 })}
                  </div>
                </div>
              : <div className="x-log-empty"><Ic name="empty" size={16} /><span>{t("x.poolEmpty")}</span></div>}
          </div>

          <div className="gw-col">
            <label>{t("x.exampleLabel")}</label>
            <div className="lang-seg x-proto-seg" style={{ marginBottom: 8 }}>
              <button className={"lang-opt" + (accProto === "openai" ? " on" : "")} onClick={() => setAccProto("openai")}>OpenAI</button>
              <button className={"lang-opt" + (accProto === "anthropic" ? " on" : "")} onClick={() => setAccProto("anthropic")}>Anthropic</button>
              <button className={"lang-opt" + (accProto === "models" ? " on" : "")} onClick={() => setAccProto("models")}>Models</button>
            </div>
            {accProto === "openai" ? (
              <div className="x-curl-grid">
                <div>
                  <div className="x-curl-cap">POST /v1/chat/completions</div>
                  <pre className="x-curl">{accessCurls[0]}</pre>
                </div>
                <div>
                  <div className="x-curl-cap">POST /v1/responses</div>
                  <pre className="x-curl">{accessCurls[1]}</pre>
                </div>
              </div>
            ) : accessCurls.map((c) => <pre key={c.slice(0, 40)} className="x-curl">{c}</pre>)}
            <button className="btn-ghost" onClick={copyExample}>{copiedEx ? t("x.copied") : t("x.copyBtn")}</button>
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
              <label>{t("x.tuneGroupNet")}</label>
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
                  <span className="x-tune-name">{t("x.tuneFails")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={failsInput}
                    onChange={(e) => setFailsInput(e.target.value)} placeholder="5" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneKeepalive")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={keepaliveInput}
                    onChange={(e) => setKeepaliveInput(e.target.value)} placeholder="15" />
                </div>
                <div className="x-tune-item">
                  <span className="x-tune-name">{t("x.tuneTimeout")}</span>
                  <input className="zcode-path" type="text" inputMode="numeric" value={timeoutInput}
                    onChange={(e) => setTimeoutInput(e.target.value)} placeholder="600" />
                </div>
              </div>
              <label style={{ marginTop: 14 }}>{t("x.tuneGroupSrv")}</label>
              <div className="x-tune">
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
              <div className="x-test-head">
                <div className="pv-title">{t("x.testTitle")}</div>
                <button className="btn-ghost x-test-close" onClick={() => setTestOpen(false)}>×</button>
              </div>
              <div className="pv-sub">{t("x.testHint")}</div>
              <label className="x-test-label">{t("x.testProto")}</label>
              <div className="lang-seg x-proto-seg">
                <button className={"lang-opt" + (testProto === "openai" ? " on" : "")} onClick={() => { setTestProto("openai"); setTestBody(""); }}>OpenAI</button>
                <button className={"lang-opt" + (testProto === "anthropic" ? " on" : "")} onClick={() => { setTestProto("anthropic"); setTestBody(""); }}>Anthropic</button>
                <button className={"lang-opt" + (testProto === "responses" ? " on" : "")} onClick={() => { setTestProto("responses"); setTestBody(""); }}>Responses</button>
              </div>
              <label className="x-test-label">{t("x.testBodyLabel")}</label>
              <textarea className="zcode-path x-test-msg x-test-body" value={testBody || defaultTestBody()}
                onChange={(e) => setTestBody(e.target.value)} rows={10} spellCheck={false} />
              <div className="pv-actions x-test-actions">
                {testBusy
                  ? <button className="btn-primary" onClick={() => testAbort.current?.abort()}>{t("x.stop")}</button>
                  : <button className="btn-primary" disabled={!running} onClick={() => guard(doTestSend)}>{t("x.testSend")}</button>}
                <button className={"btn-ghost" + (testShowCode ? " x-btn-on" : "")} onClick={() => setTestShowCode(!testShowCode)}>curl</button>
                <button className="btn-ghost" onClick={() => setTestOpen(false)}>{t("common.cancel")}</button>
              </div>
              {testShowCode
                ? <pre className="x-test-curl">{testCurl}</pre>
                : null}
              {testResult
                ? <>
                    <label className="x-test-label">{t("x.testResult")}</label>
                    <div className={"x-test-out" + (testResult.ok ? "" : " bad")}>
                      <div className="x-test-meta">
                        <span className={"x-test-dot " + (testResult.ok ? "ok" : "bad")} />
                        {testResult.status ? `HTTP ${testResult.status} · ` : ""}{testResult.ms}ms{testResult.stream ? ` · ${t("x.stream")}` : ""}{testResult.ttft != null ? ` · TTFT ${testResult.ttft}ms` : ""}
                        {(testResult.tin != null || testResult.tout != null)
                          ? ` · ${testResult.tout ?? 0}↑ / ${testResult.tin ?? 0}↓`
                          : ""}
                      </div>
                      <div className="x-test-text">{testResult.text}</div>
                    </div>
                  </>
                : null}
              {testHistory.length > 1
                ? <>
                    <label className="x-test-label">{t("x.testHistory")}</label>
                    <div className="x-test-hist">
                      {testHistory.slice(1).map((h, i) => (
                        <div key={i} className="x-test-hist-row">
                          <span className={"x-test-dot " + (h.ok ? "ok" : "bad")} />
                          <span className="x-test-hist-ms">{(h.proto === "anthropic" ? "ANT" : "OAI") + (h.stream ? "·SSE" : "")} · {h.ms}ms</span>
                          <span className="x-test-hist-text">{h.text.slice(0, 60)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                : null}
            </div>
          </div>
        : null}
    </>
  );
}
