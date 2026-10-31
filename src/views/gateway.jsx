// React 版 2API 页：反代服务控制面板（M1 接线 + 完整面板视觉）
// 服务本体为 Rust 内嵌 axum（src-tauri/src/gateway/），本页是其控制面。
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
  const [showKey, setShowKey] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await invoke("twoapi_status"));
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
    await invoke("twoapi_start", { port: null, apiKey: null });
  });
  const doStop = () => guard(async () => {
    await invoke("twoapi_stop");
  });
  const doSave = () => guard(async () => {
    const p = parseInt(port.trim(), 10);
    if (!Number.isFinite(p) || p <= 0 || p > 65535) throw new Error(t("x.badPort"));
    await invoke("twoapi_start", { port: p, apiKey: apiKey.trim() || null });
    setApiKey("");
  });

  const endpoint = `http://127.0.0.1:${status?.port ?? 8081}/v1`;
  const curlSample =
    `curl ${endpoint}/chat/completions \\\n` +
    `  -H "Authorization: Bearer ${status?.apiKeyMasked || "sk-…"}" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'`;

  return (
    <div className="about-wrap">
      <div className="about-card twoapi-card">
        {/* 状态头 */}
        <div className="x-head">
          <span className={"x-lamp" + (running ? " on" : "")} />
          <div>
            <div className="x-title">2API Gateway</div>
            <div className={"x-state" + (running ? " on" : "")}>
              {running ? t("x.running") : t("x.stopped")}
            </div>
          </div>
          <div className="x-head-actions">
            {running
              ? <button className="btn-ghost has-ic" disabled={busy} onClick={doStop}><Ic name="power" size={14} /> {t("x.stop")}</button>
              : <button className="btn-primary has-ic" disabled={busy} onClick={doStart}><Ic name="play" size={14} /> {t("x.start")}</button>}
          </div>
        </div>

        {/* endpoint 展示行 */}
        <div className="x-endpoint">
          <span className="x-endpoint-label">ENDPOINT</span>
          <code>{endpoint}</code>
        </div>

        {/* 配置区 */}
        <div className="x-section">
          <div className="x-label">{t("x.cfgLabel")}</div>
          <div className="path-line">
            <input className="zcode-path" type="text" value={port}
              onChange={(e) => setPort(e.target.value)} placeholder="8081" />
            <span className="x-field-tag">PORT</span>
          </div>
          <div className="path-line">
            <input className="zcode-path" type="text" value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.apiKeyMasked || t("x.apiKeyPh")} />
            <span className="x-field-tag">API KEY</span>
            <button className="btn-ghost" disabled={!canSave || busy}
              onClick={() => guard(doSave)}>{t("common.save")}</button>
          </div>
          {status?.apiKeyMasked
            ? <div className="x-key-row">
                <span className="x-key-label">{t("x.apiKeyNow")}</span>
                <code className="x-key-val">{showKey ? "明文不出前端" : status.apiKeyMasked}</code>
                <button className="x-key-toggle" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? t("x.hide") : t("x.show")}
                </button>
              </div>
            : null}
        </div>

        {/* curl 示例 */}
        <div className="x-section">
          <div className="x-label">{t("x.exampleLabel")}</div>
          <pre className="x-curl">{curlSample}</pre>
        </div>

        {/* 日志空态（M5 接数据源后替换为真实日志列表） */}
        <div className="x-section">
          <div className="x-label">{t("x.logLabel")}</div>
          <div className="x-log-empty">
            <Ic name="empty" size={18} />
            <span>{t("x.logEmpty")}</span>
          </div>
        </div>

        {err ? <div className="x-err">{err}</div> : null}
      </div>
    </div>
  );
}
