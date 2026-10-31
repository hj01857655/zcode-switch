// React 版关于页：版本、GitHub、账号库安全说明（自设置页迁出）
// 视觉：居中卡片，与主窗暗色主题同语言（panel + hairline + amber 点缀）
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";

export default function AboutPage() {
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    invoke("app_version").then((v) => setAppVer(v || "")).catch(() => {});
  }, []);

  return (
    <div className="about-wrap">
      <div className="about-card">
        <div className="about-brand">
          <span className="about-mark">Z·SWITCH</span>
          {appVer ? <span className="about-ver">v{appVer}</span> : <span className="about-ver">…</span>}
        </div>

        <a className="about-repo" href="https://github.com/pjpv/zcode-switch" target="_blank" rel="noopener"
          onClick={(e) => { e.preventDefault(); invoke("open_external", { url: "https://github.com/pjpv/zcode-switch" }).catch(() => {}); }}>
          <span className="about-repo-line">{t("a.repoLabel")}</span>
          <span className="about-repo-url">github.com/pjpv/zcode-switch</span>
          <span className="about-repo-desc">{t("s.githubLink")}</span>
        </a>

        <div className="about-block">
          <div className="about-label">{t("a.safetyLabel")}</div>
          <p>{t("s.hint")}</p>
        </div>

        <div className="about-foot">{t("a.credit")}</div>
      </div>
    </div>
  );
}
