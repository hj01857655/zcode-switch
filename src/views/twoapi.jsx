// React 版 2API 页：反代服务控制面板（占位骨架）
// 服务本体（ZCode2api-go 旁挂 / 内嵌 axum）后接，本页先落 UI 结构：
// 状态灯 + 端口/密钥表单 + 启停按钮（disabled，接后端命令后启用）
import { useEffect, useState } from "react";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";

export default function TwoApiPage() {
  const [port, setPort] = useState("8081");
  const [apiKey, setApiKey] = useState("");
  const [running, setRunning] = useState(false);

  return (
    <div className="about-wrap">
      <div className="about-card twoapi-card">
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
          <button className="btn-ghost" disabled>{t("common.save")}</button>
        </div>

        <div className="path-line">
          <input className="zcode-path" type="text" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("x.apiKeyPh")} />
          <button className="btn-ghost" disabled>{t("common.save")}</button>
        </div>

        <div className="twoapi-actions">
          <button className="btn-primary has-ic" disabled={!running}>
            <Ic name="power" size={15} /> {t("x.stop")}
          </button>
          <button className="btn-primary has-ic" disabled={running}>
            <Ic name="play" size={15} /> {t("x.start")}
          </button>
        </div>

        <div className="about-foot">{t("x.wipNote")}</div>
      </div>
    </div>
  );
}
