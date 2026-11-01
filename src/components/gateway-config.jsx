// 配置对话框：调优项（连接/重试/退避/熔断/保活/超时/CORS/体积/日志/sticky）
// 保存只写调优项（端口/密钥传 null 沿用盘上值）；对话框关闭时草稿跟随盘上真值，开着编辑不被轮询覆盖
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";

export function GatewayConfigModal({ open, onClose, status, busy, guard }) {
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
  const openRef = useRef(false);
  useEffect(() => { openRef.current = open; }, [open]);

  // 盘上真值跟进：只在对话框关闭时刷新草稿（v || 保留用户已填值），开着编辑不被轮询覆盖
  useEffect(() => {
    if (open || !status) return;
    setConnectInput((v) => v || String(status.upstreamConnectSecs ?? ""));
    setRetriesInput((v) => v || String(status.maxRetries ?? ""));
    setBackoffInput((v) => v || String(status.globalBackoffSecs ?? ""));
    setCorsInput((v) => v || (status.corsOrigins || []).join(", "));
    setBodyLimitInput((v) => v || String(status.bodyLimitMb ?? ""));
    setLogMaxInput((v) => v || String(status.logFileMaxMb ?? ""));
    setFailsInput((v) => v || String(status.allowedFails ?? ""));
    setKeepaliveInput((v) => v || String(status.keepaliveSecs ?? ""));
    setTimeoutInput((v) => v || String(status.totalTimeoutSecs ?? ""));
    setLogDiskInput(status.logToDisk !== false);
    setStickyInput(status.sticky !== false);
  }, [status, open]);

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

  const doSaveTune = async () => {
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
    onClose();
  };

  if (!open) return null;
  return (
    <div className="pv-mask" onClick={onClose}>
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
          <button className="btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn-ghost" disabled={!tuneDirty || busy} onClick={() => guard(doSaveTune)}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
