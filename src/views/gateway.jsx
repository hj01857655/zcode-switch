// React 版 Gateway 页：反代服务控制面板（M1 接线 gateway_start/stop/status）
// 布局与设置页同构（靠左表单流 .settings），状态区置顶。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";

export default function GatewayPage() {
  const [status, setStatus] = useState(null);
  const [port, setPort] = useState("8081");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refresh = async () => {
    try {
      setStatus(await invoke("gateway_status"));
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), 2000);
    return () => clearInterval(timer);
  }, []);

  const running = status?.running ?? false;
  const portDirty = status != null && String(status.port) !== port.trim();
  const keyDirty = apiKey.trim() !== "";
  const canSave = !running && (portDirty || keyDirty);

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
  const doStop = () => guard(async () => {
    await invoke("gateway_stop");
  });
  const doSave = () => guard(async () => {
    const p = parseInt(port.trim(), 10);
    if (!Number.isFinite(p) || p <= 0 || p > 65535) throw new Error(t("x.badPort"));
    await invoke("gateway_start", { port: p, apiKey: apiKey.trim() || null });
    setApiKey("");
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
        <span className="tb-spacer" />
      </section>
      <section className="settings open">
        <label>{t("x.endpointLabel")}</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={endpoint} readOnly />
        </div>

        <label style={{ marginTop: 14 }}>PORT</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={port}
            onChange={(e) => setPort(e.target.value)} placeholder="8081" />
          <button className="btn-ghost" disabled={!canSave || busy} onClick={() => guard(doSave)}>
            {t("common.save")}
          </button>
        </div>

        <label style={{ marginTop: 14 }}>API KEY</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status?.apiKeyMasked || t("x.apiKeyPh")} />
          <button className="btn-ghost" disabled={!canSave || busy} onClick={() => guard(doSave)}>
            {t("common.save")}
          </button>
        </div>
        {status?.apiKeyMasked
          ? <div className="hint" style={{ marginTop: 6 }}>{t("x.apiKeyNow")} <code>{status.apiKeyMasked}</code></div>
          : null}

        <label style={{ marginTop: 14 }}>{t("x.exampleLabel")}</label>
        <pre className="x-curl">{curlSample}</pre>

        <label style={{ marginTop: 14 }}>FARM · {t("x.farmLabel")}</label>
        {status?.farm?.members?.length
          ? <div className="x-farm">
              {status.farm.members.map((m) => (
                <div className="x-farm-row" key={m.id}>
                  <span className={"x-farm-dot" + (m.cooldown_secs > 0 ? " cool" : m.inflight > 0 ? " busy" : "")} />
                  <span className="x-farm-name" title={m.id}>{m.name}</span>
                  {m.inflight > 0 ? <span className="x-farm-tag">{t("x.inflight")} {m.inflight}</span> : null}
                  {m.cooldown_secs > 0
                    ? <span className="x-farm-tag warn">{t("x.cooldown")} {m.cooldown_secs}s</span>
                    : null}
                </div>
              ))}
              {status.farm.global_backoff_secs > 0
                ? <div className="x-farm-global warn">{t("x.globalBackoff")} {status.farm.global_backoff_secs}s</div>
                : null}
              <div className="x-farm-stats">
                {t("x.farmStats", { ok: status.farm.total_ok ?? 0, err: status.farm.total_err ?? 0 })}
              </div>
            </div>
          : <div className="x-log-empty"><Ic name="empty" size={16} /><span>{t("x.farmEmpty")}</span></div>}

        <label style={{ marginTop: 14 }}>{t("x.logLabel")}</label>
        {status?.logs?.length
          ? <div className="x-log-list">
              {status.logs.slice().reverse().map((l, i) => (
                <div className="x-log-row" key={i}>
                  <span className="x-log-ts">{l.ts}</span>
                  <span className="x-log-ep">{l.ep}</span>
                  <span className="x-log-acct">{l.account}</span>
                  <span className={"x-log-code" + (l.ok ? " ok" : " fail")}>{l.status}</span>
                </div>
              ))}
            </div>
          : <div className="x-log-empty">
              <Ic name="empty" size={18} />
              <span>{t("x.logEmpty")}</span>
            </div>}

        <div className="hint">{t("x.endpointDesc")}</div>
        {err ? <div className="hint" style={{ color: "var(--red)" }}>{err}</div> : null}
      </section>
    </>
  );
}
