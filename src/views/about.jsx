// React 版关于页：版本、功能特性、账号库安全说明、上游仓库（自设置页迁出）
// 视觉：平铺整页，与设置页同语言（无卡片壳，panel 分区 + hairline + amber 点缀）
// 订阅 store：语言快捷钮切换时本页文案即时跟随，不需切走再切回
import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { subscribe, getVersion } from "../lib/store.js";

function Feature({ title, desc }) {
  return (
    <div className="about-feat">
      <div className="about-feat-title">{title}</div>
      <div className="about-feat-desc">{desc}</div>
    </div>
  );
}

export default function AboutPage() {
  useSyncExternalStore(subscribe, getVersion);
  const [appVer, setAppVer] = useState("");
  useEffect(() => {
    invoke("app_version").then((v) => setAppVer(v || "")).catch(() => setAppVer("-"));
  }, []);

  return (
    <div className="about-wrap">
      <div className="about-card">
        <div className="about-brand">
          <span className="about-mark">Z·SWITCH</span>
          {appVer === ""
            ? <span className="about-ver">…</span>
            : appVer !== "-" && <span className="about-ver">v{appVer}</span>}
          <span className="about-tagline">{t("a.tagline")}</span>
        </div>

        <div className="about-block">
          <div className="about-label">{t("a.featLabel")}</div>
          <div className="about-feats">
            <Feature title={t("a.feat1t")} desc={t("a.feat1d")} />
            <Feature title={t("a.feat2t")} desc={t("a.feat2d")} />
            <Feature title={t("a.feat3t")} desc={t("a.feat3d")} />
            <Feature title={t("a.feat4t")} desc={t("a.feat4d")} />
          </div>
        </div>

        <div className="about-block">
          <div className="about-label">{t("a.safetyLabel")}</div>
          <p>{t("s.hint")}</p>
          <p>{t("a.safetyDetail")}</p>
        </div>

        <a className="about-repo" href="https://github.com/hj01857655/zcode-switch" target="_blank" rel="noopener"
          onClick={(e) => { e.preventDefault(); invoke("open_external", { url: "https://github.com/hj01857655/zcode-switch" }).catch(() => {}); }}>
          <span className="about-repo-line">{t("a.repoLabel")}</span>
          <span className="about-repo-url">github.com/hj01857655/zcode-switch</span>
          <span className="about-repo-desc">{t("s.githubLink")}</span>
        </a>

        <div className="about-foot">{t("a.credit")}</div>
      </div>
    </div>
  );
}
