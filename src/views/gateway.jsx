// React 版 2API 页：反代服务控制面板（M1 已接线 gateway_start/stop/status）
// 服务本体为 Rust 内嵌 axum（src-tauri/src/gateway/），本页是其控制面。
// 注：文件为 .jsx（非 .tsx），不可用 TS 类型标注。
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
      const s = await invoke("gateway_status");
      setStatus(s);
      setPort(String(s.port));
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
  // 保存启用规则：服务未运行 且 表单值与持久值不一致
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
    // start 语义含配置更新；未运行时需要先落配置再启动
    const s = await invoke("gateway_status");
    if (!s.running) await invoke("gateway_start", { port: p, apiKey: apiKey.trim() || null });
    setApiKey("");
  });

  return (
    <div className="about-wrap">
      <div className="about-card gateway-card">
        <div className="about-brand">
          <span className="about-mark">2API</span>
          <span className={"about-ver " + (running ? "on" : "")}>
            {running ? t("x.running") : t("x.stopped")}
          </span>
        </div>

        <div className="about-block">
          <div className="about-label">{t("x.endpointLabel")}</div>
          <p>{t("x.endpointDesc")}</p>
        </div>

        <div className="path-line">
          <input className="zcode-path" type="text" value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8081" />
          <button className="btn-ghost" disabled={!canSave || busy} onClick={() => guard(doSave)}>
            {t("common.save")}
          </button>
        </div>

        <div className="path-line">
          <input className="zcode-path" type="text" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status?.apiKeyMasked || t("x.apiKeyPh")} />
          <button className="btn-ghost" disabled={!canSave || busy} onClick={() => guard(doSave)}>
            {t("common.save")}
          </button>
        </div>

        <div className="gateway-actions">
          <button className="btn-primary has-ic" disabled={!running || busy} onClick={doStop}>
            <Ic name="power" size={15} /> {t("x.stop")}
          </button>
          <button className="btn-primary has-ic" disabled={running || busy} onClick={doStart}>
            <Ic name="play" size={15} /> {t("x.start")}
          </button>
        </div>

        {status?.apiKeyMasked ? (
          <div className="about-foot">{t("x.apiKeyNow")} {status.apiKeyMasked}</div>
        ) : null}
        {err ? <div className="about-foot" style={{ color: "var(--red)" }}>{err}</div> : null}
      </div>
    </div>
  );
}
