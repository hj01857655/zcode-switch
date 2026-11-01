// React 版关于页：版本、应用内更新、功能特性、账号库安全说明、上游仓库（自设置页迁出）
// 视觉：平铺整页，与设置页同语言（无卡片壳，panel 分区 + hairline + amber 点缀）
// 订阅 store：语言快捷钮切换时本页文案即时跟随，不需切走再切回
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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

// 应用内更新：关于页手动检查（端点 404 在首个签名版本发布前必然出现，故不做进页自动检查）；
// 发现新版本后下载并安装，Windows 下安装器自行接管重启，relaunch 兜底其余平台
const UP_IDLE = { st: "idle", ver: "", pct: 0, err: "" };

export default function AboutPage() {
  useSyncExternalStore(subscribe, getVersion);
  const [appVer, setAppVer] = useState("");
  const [up, setUp] = useState(UP_IDLE);
  const upRef = useRef(null);
  useEffect(() => {
    invoke("app_version").then((v) => setAppVer(v || "")).catch(() => setAppVer("-"));
  }, []);

  async function runCheck() {
    setUp({ ...UP_IDLE, st: "checking" });
    try {
      const u = await check();
      if (!u) { setUp({ ...UP_IDLE, st: "latest" }); return; }
      upRef.current = u;
      setUp({ ...UP_IDLE, st: "available", ver: u.version });
    } catch (e) {
      setUp({ ...UP_IDLE, st: "err", err: String(e) });
    }
  }

  async function doInstall() {
    setUp((s) => ({ ...s, st: "downloading", pct: 0 }));
    try {
      let received = 0;
      let total = 0;
      await upRef.current.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength || 0;
        } else if (evt.event === "Progress") {
          received += evt.data.chunkLength;
          if (total > 0) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            setUp((s) => (s.st === "downloading" ? { ...s, pct } : s));
          }
        } else if (evt.event === "Finished") {
          setUp((s) => ({ ...s, pct: 100 }));
        }
      });
      await relaunch();
    } catch (e) {
      setUp({ ...UP_IDLE, st: "err", err: String(e) });
    }
  }

  const updRow =
    up.st === "idle" ? (
      <button type="button" className="btn-ghost" onClick={runCheck}>{t("a.updCheck")}</button>
    ) : up.st === "checking" ? (
      <span className="about-upd-hint">{t("a.updChecking")}</span>
    ) : up.st === "latest" ? (
      <span className="about-upd-hint">{t("a.updLatest")}</span>
    ) : up.st === "available" ? (
      <>
        <span className="about-upd-hint">{t("a.updAvailable", { ver: up.ver })}</span>
        <button type="button" className="btn-ghost" onClick={doInstall}>{t("a.updInstall")}</button>
      </>
    ) : up.st === "downloading" ? (
      <span className="about-upd-hint">{t("a.updDownloading")} {up.pct}%</span>
    ) : (
      <>
        <span className="about-upd-err">{t("a.updFail", { err: up.err })}</span>
        <button type="button" className="btn-ghost" onClick={runCheck}>{t("a.updRetry")}</button>
      </>
    );

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

        <div className="about-block about-upd">
          <div className="about-label">{t("a.updLabel")}</div>
          <div className="about-upd-row">{updRow}</div>
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
