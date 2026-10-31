// React 版关于页：版本、GitHub、账号库安全说明（自设置页迁出）
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";

export default function AboutPage() {
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    invoke("app_version").then((v) => setAppVer(v || "")).catch(() => {});
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="wordmark">Z·SWITCH {appVer ? <span className="ver">v{appVer}</span> : null}</div>
      </header>
      <section className="settings open about">
        <label>{t("a.verLabel")}</label>
        <div className="hint">{appVer ? `Z·SWITCH v${appVer}` : "…"}</div>
        <label style={{ marginTop: 14 }}>{t("a.repoLabel")}</label>
        <div className="gh-row">
          <a className="gh-link" href="https://github.com/pjpv/zcode-switch" target="_blank" rel="noopener"
            onClick={(e) => { e.preventDefault(); invoke("open_external", { url: "https://github.com/pjpv/zcode-switch" }).catch(() => {}); }}>
            {t("s.githubLink")}
          </a>
        </div>
        <label style={{ marginTop: 14 }}>{t("a.safetyLabel")}</label>
        <div className="hint">{t("s.hint")}</div>
        <div className="hint">{t("a.credit")}</div>
      </section>
    </>
  );
}
