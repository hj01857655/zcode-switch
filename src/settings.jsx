// React 版设置页：逻辑与原生 settings.js 一一对应（保留为回退），弹窗/toast 复用 ui.js，
// ui.js 副作用（右键与快捷键屏蔽）随导入生效
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast, openPwModal, dismissSplash } from "./ui.js";
import { Ic } from "./iconsx.jsx";
import { init, t, lang, stripErr } from "./i18n.js";

function Toggle({ on, label, desc, onClick }) {
  return (
    <div className="tog-row">
      <div className="tog-info">
        <div className="tog-label">{label}</div>
        <div className="tog-desc">{desc}</div>
      </div>
      <button
        className={"toggle" + (on ? " on" : "")}
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onClick}
      >
        <span className="knob"></span>
      </button>
    </div>
  );
}

function LangSeg({ cur, onPick }) {
  return (
    <div className="tog-row">
      <div className="tog-info"><div className="tog-label">{t("s.langLabel")}</div></div>
      <div className="lang-seg" role="radiogroup" aria-label={t("s.langLabel")}>
        <button className={"lang-opt" + (cur === "zh" ? " on" : "")} role="radio" aria-checked={cur === "zh"} onClick={() => onPick("zh")}>{t("s.langZh")}</button>
        <button className={"lang-opt" + (cur === "en" ? " on" : "")} role="radio" aria-checked={cur === "en"} onClick={() => onPick("en")}>{t("s.langEn")}</button>
      </div>
    </div>
  );
}

export default function SettingsPage({ embedded = false }) {
  const [state, setState] = useState(null);
  const [autostart, setAutostart] = useState(false);
  const [appVer, setAppVer] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const busy = useRef(false);

  const guard = async (fn) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } catch (e) {
      toast(stripErr(e), "err");
    } finally {
      busy.current = false;
    }
  };

  const refresh = async () => {
    const s = await invoke("get_state");
    setState(s);
    setPathInput(s.zcode_path || "");
    setProxyInput(s.auth_proxy_url || "");
    setAutostart(await invoke("autostart_status").catch(() => false));
    if (s?.language) init(s.language);
  };

  useEffect(() => {
    const un = listen("state-changed", () => refresh().catch(() => {}));
    (async () => {
      try {
        setAppVer((await invoke("app_version").catch(() => "")) || "");
        await refresh();
        dismissSplash();
      } catch (e) {
        setLoadErr(String(e));
        dismissSplash();
      }
    })();
    return () => { un.then((f) => f()); };
  }, []);

  if (loadErr) {
    return <div className="loading" style={{ color: "var(--red)" }}>{t("common.loadFail", { e: loadErr })}</div>;
  }
  if (!state) {
    return <div className="loading">LOADING</div>;
  }

  const s = state;
  document.title = `Z·SWITCH ${t("s.title")}`;

  const finishImport = async (report) => {
    if (report.added.length === 0 && report.skipped.length === 0) {
      toast(t("s.importNone"), "err", report.errors.join(t("common.listSep")) || undefined);
    } else {
      const parts = [];
      if (report.added.length) parts.push(t("s.importAdded", { count: report.added.length, names: report.added.join(t("common.listSep")) }));
      if (report.skipped.length) parts.push(t("s.importSkipped", { count: report.skipped.length }));
      if (report.errors.length) parts.push(t("s.importFailed", { count: report.errors.length }));
      toast(parts[0], report.errors.length ? "err" : "ok", parts.slice(1).join(t("common.listSep")));
    }
    await refresh();
  };

  const actions = {
    setLang: (l) => guard(async () => {
      if (l === lang()) return;
      await invoke("set_language", { lang: l });
      await refresh();
      setState((v) => ({ ...v }));
    }),

    toggleAutostart: () => guard(async () => {
      const v = await invoke("autostart_set", { enable: !autostart });
      setAutostart(v);
      toast(v ? t("s.autostartOnToast") : t("s.autostartOffToast"));
    }),

    toggleBehavior: (key) => guard(async () => {
      await invoke("set_behavior", {
        launchAfterSwitch: key === "launch" ? !s.launch_after_switch : null,
        closeToTray: key === "tray" ? !s.close_to_tray : null,
        hotSwitch: key === "hot" ? !s.hot_switch : null,
      });
      await refresh();
      toast(t("s.savedToast"));
    }),

    exportAll: () => guard(async () => {
      const p = await invoke("export_all_pick_path");
      if (!p.picked) { toast(t("m.exportCanceled")); return; }
      openPwModal({ mode: "exportAll", path: p.path, count: p.count, onDone: () => refresh() });
    }),

    importFiles: () => guard(async () => {
      const p = await invoke("import_pick_files");
      if (!p.picked) return;
      const sealed = p.sealed || [];
      const preErrors = p.errors || [];
      if (sealed.length) {
        openPwModal({ mode: "import", files: sealed, preErrors, onDone: finishImport });
        return;
      }
      finishImport({ added: [], skipped: [], errors: preErrors });
    }),

    browsePath: () => guard(async () => {
      const r = await invoke("pick_zcode_path");
      if (r.picked) {
        await invoke("set_zcode_path", { path: r.path });
        toast(t("s.pathUpdated"));
        await refresh();
      }
    }),

    savePath: () => guard(async () => {
      const v = pathInput.trim();
      await invoke("set_zcode_path", { path: v });
      toast(v ? t("s.pathUpdated") : t("s.pathAuto"));
      await refresh();
    }),

    toggleAuthProxy: () => guard(async () => {
      const url = proxyInput.trim() || s.auth_proxy_url || null;
      await invoke("set_auth_proxy", { on: !s.auth_proxy_on, url });
      await refresh();
      toast(s.auth_proxy_on ? t("s.proxyOffToast") : t("s.proxyOnToast"), "ok", t("s.proxyOnDetail"));
    }),

    saveProxy: () => guard(async () => {
      await invoke("set_auth_proxy", { on: s.auth_proxy_on, url: proxyInput.trim() });
      await refresh();
      toast(t("s.proxySaved"), "ok",
        s.auth_proxy_on ? t("s.proxySavedOn") : t("s.proxySavedOff"));
    }),

    openGitHub: () => invoke("open_external", { url: "https://github.com/pjpv/zcode-switch" }),
  };

  return (
    <>
      {!embedded && (
        <header className="topbar">
          <div className="wordmark">Z·SWITCH <span className="ver">/ {t("s.title")}</span></div>
        </header>
      )}
      <section className="settings open">
        <LangSeg cur={s.language || "zh"} onPick={actions.setLang} />
        <label>BEHAVIOR · {t("s.behaviorLabel")}</label>
        <Toggle on={autostart} label={t("s.autostart")} desc={t("s.autostartDesc")} onClick={actions.toggleAutostart} />
        <Toggle on={s.launch_after_switch} label={t("s.launchAfter")} desc={t("s.launchAfterDesc")} onClick={() => actions.toggleBehavior("launch")} />
        <Toggle on={s.close_to_tray} label={t("s.closeTray")} desc={t("s.closeTrayDesc")} onClick={() => actions.toggleBehavior("tray")} />
        <Toggle on={s.hot_switch} label={t("s.hotSwitch")} desc={t("s.hotSwitchDesc")} onClick={() => actions.toggleBehavior("hot")} />
        <label style={{ marginTop: 14 }}>{t("s.authLabel")}</label>
        <Toggle on={s.auth_proxy_on} label={t("s.proxyToggle")} desc={t("s.proxyToggleDesc")} onClick={actions.toggleAuthProxy} />
        <div className="path-line" style={{ marginTop: 6 }}>
          <input className="zcode-path auth-proxy" type="text" value={proxyInput}
            placeholder={t("s.proxyPh")}
            onChange={(e) => setProxyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") actions.saveProxy(); }} />
          <button className="btn-ghost" onClick={actions.saveProxy}>{t("common.save")}</button>
        </div>
        <label style={{ marginTop: 14 }}>{t("s.libLabel")}</label>
        <div className="lib-row">
          <button className="btn-ghost has-ic" onClick={actions.importFiles}><Ic name="import" size={14} /> {t("s.importBtn")}</button>
          <button className="btn-ghost has-ic" onClick={actions.exportAll} disabled={!s.accounts.length}><Ic name="exportAll" size={14} /> {t("s.exportAllBtn")}</button>
        </div>
        <label style={{ marginTop: 14 }}>{t("s.pathLabel")}</label>
        <div className="path-line">
          <input className="zcode-path" type="text" value={pathInput} placeholder="C:\\Program Files\\ZCode\\ZCode.exe"
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") actions.savePath(); }} />
          <button className="btn-ghost" onClick={actions.browsePath}>{t("s.browse")}</button>
          <button className="btn-ghost" onClick={actions.savePath}>{t("common.save")}</button>
        </div>
        <div className="hint">{t("s.hint")}</div>
        <div className="gh-row">
          <a className="gh-link" href="https://github.com/pjpv/zcode-switch" target="_blank" rel="noopener" onClick={(e) => { e.preventDefault(); actions.openGitHub(); }}>{t("s.githubLink")}</a>
          {appVer ? <span className="ver">v{appVer}</span> : ""}
        </div>
      </section>
    </>
  );
}
