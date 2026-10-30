// App.jsx — 渲染层根组件。class 名与 DOM 层级保持与原 innerHTML 模板一致，CSS 无需改动。
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Ic } from "./iconsx.jsx";
import { t } from "./i18n.js";
import {
  store, subscribe, getVersion, boot, actions, runtimeFlags,
  notchColor, autoPillTitle, accountName,  // eslint-disable-line no-unused-vars
} from "./store.js";
import { expireInfo, tierBadges } from "./quotaView.js";
import { AccountQuotaSlot, TierBadges } from "./QuotaView.jsx";

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function TopBar({ s, unsaved }) {
  const dotCls = s.zcode_running ? "run" : s.live_logged_in ? "" : "off";
  const statusText = s.zcode_running
    ? t("m.status.running")
    : s.live_logged_in
      ? unsaved ? t("m.status.unsaved") : t("m.status.safe")
      : t("m.status.loggedOut");
  return (
    <header className="topbar">
      <div className="wordmark">
        Z·SWITCH{store.appVer ? <span className="ver">v{store.appVer}</span> : null}
      </div>
      <div className={"top-status" + (unsaved ? " unsaved" : "")}>
        <span className={"status-dot " + dotCls} />
        <span className="status-text">{statusText}</span>
      </div>
    </header>
  );
}

function Toolbar({ s, active, unsaved, claimableCount }) {
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const cooling = Date.now() < refreshClaim.cooldownUntil;
  return (
    <section className="toolbar">
      <button
        className={"btn-primary has-ic" + (unsaved ? " attention" : "")}
        onClick={() => actions.capture()}
        disabled={!s.live_logged_in || !!active}
        title={active ? t("m.saveLoginDisabledTitle", { name: active.name }) : ""}
      >
        <Ic name="capture" size={16} /> {t("btn.saveLogin")}
      </button>

      {claimableCount > 0 ? (
        <button
          className="btn-ghost has-ic claim-all"
          onClick={() => actions.claimAll()}
          disabled={claimAllRunning || refreshClaim.running || autoClaimRunning}
          title={t("btn.claimAllTitle")}
        >
          <Ic name="gift" size={16} /> {t("btn.claimAll")}
          {claimableCount > 1 ? ` (${claimableCount})` : ""}
        </button>
      ) : null}

      {s.accounts.length > 0 ? (
        <button
          className="btn-ghost has-ic"
          onClick={() => actions.refreshClaim()}
          disabled={refreshClaim.running || claimAllRunning || cooling}
          title={cooling && !refreshClaim.running
            ? t("btn.refreshClaimCooldownTitle", { n: Math.ceil((refreshClaim.cooldownUntil - Date.now()) / 1000) })
            : t("btn.refreshClaimTitle")}
        >
          <Ic name="refresh" size={16} />{" "}
          {refreshClaim.running
            ? t("btn.refreshClaimRunning", { done: refreshClaim.done, total: refreshClaim.total })
            : t("btn.refreshClaim")}
        </button>
      ) : null}

      <button
        className={"tog-inline" + (s.auto_claim ? " on" : "") + (autoClaimRunning ? " running" : "")}
        role="switch"
        aria-checked={s.auto_claim}
        aria-label={t("btn.autoClaim")}
        title={autoPillTitle(s)}
        onClick={() => actions.toggleAutoClaim()}
      >
        <span className={"toggle" + (s.auto_claim ? " on" : "")} aria-hidden="true">
          <span className="knob" />
        </span>
        {t("btn.autoClaim")}
      </button>

      <button className="btn-ghost has-ic" onClick={() => actions.addAccount()} title={t("btn.addAccountTitle")}>
        <Ic name="userPlus" size={16} /> {t("btn.addAccount")}
      </button>

      {s.zcode_running ? (
        <button className="btn-ghost has-ic" onClick={() => actions.askKill()} title={t("btn.killZcode")}>
          <Ic name="power" size={16} /> {t("btn.killZcode")}
        </button>
      ) : (
        <button className="btn-ghost has-ic" onClick={() => actions.launch()} disabled={!s.zcode_path_ok}>
          <Ic name="play" size={14} /> {t("btn.launchZcode")}
        </button>
      )}

      <span className="tb-spacer" />
      <button
        className="btn-ghost tb-gear has-ic"
        onClick={() => actions.openSettings()}
        aria-label={t("common.settings")}
        title={t("common.settings")}
      >
        <Ic name="sliders" size={16} />
      </button>
    </section>
  );
}

function RenameRow({ a, isActive }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <span className="notch" style={{ background: notchColor(a.id) }} />
      <div className="row-main">
        <input
          ref={inputRef}
          className="rename-input"
          value={store.renamingText}
          maxLength={40}
          onChange={(e) => actions.setRenamingText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") actions.doRename(a.id);
            if (e.key === "Escape") actions.cancelRename();
          }}
          onBlur={() => actions.deferCancelRename(a.id)}
        />
        <div className="row-meta">{t("btn.renameMeta")}</div>
      </div>
      <div className="row-actions">
        <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => actions.doRename(a.id)}>
          {t("common.save")}
        </button>
        <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={() => actions.cancelRename()}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function AccountRow({ a, quota, plan, claimDisabled }) {
  const isActive = a.is_active;
  if (store.renaming === a.id) return <RenameRow a={a} isActive={isActive} />;

  const ident = [a.identity?.username, a.identity?.email].filter(Boolean).join(" · ");
  const exp = expireInfo(quota?.data?.plan_expire, quota?.data?.plan_starts);
  const metaBits = [];
  if (!a.has_config) metaBits.push(<span key="cfg" className="no-cfg">{t("q.noCfg")}</span>);
  if (exp) {
    metaBits.push(
      <span key="exp" className={exp.warn ? "warn-line" : ""}>
        {t("q.validUntil", { date: exp.text })}
      </span>,
    );
  }
  if (ident) {
    if (metaBits.length) metaBits.push(<span key="sep">{" · "}</span>);
    metaBits.push(<span key="ident">{ident}</span>);
  }

  const badges = tierBadges(quota?.data);

  return (
    <div className={"row" + (isActive ? " active" : "")} data-id={a.id}>
      <div className="row-top">
        <span className="notch" style={{ background: notchColor(a.id) }} />
        <div className="row-main">
          <div className="row-name">
            {a.name}
            <TierBadges pairs={badges} />
            {isActive ? <span className="tag-use">{t("btn.inUse")}</span> : null}
            {a.has_user_info === false
              ? <span className="tag-relogin" title={t("btn.reloginTitle")}>{t("btn.relogin")}</span>
              : null}
            {a.jwt_expired
              ? <span className="tag-relogin" title={t("btn.jwtExpiredTitle")}>{t("btn.jwtExpired")}</span>
              : null}
          </div>
          <div className="row-meta">{metaBits}</div>
        </div>
        <div className="row-actions">
          <button className="icon-btn" title={t("btn.quota")} aria-label={t("btn.quota")} onClick={() => actions.acctQuota(a.id)}>
            <Ic name="gauge" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.rename")} aria-label={t("btn.rename")} onClick={() => actions.rename(a.id)}>
            <Ic name="pen" size={16} />
          </button>
          <button className="icon-btn" title={t("btn.export")} aria-label={t("btn.export")} onClick={() => actions.exportOne(a.id)}>
            <Ic name="export" size={16} />
          </button>
          <button className="icon-btn danger" title={t("btn.delete")} aria-label={t("btn.delete")} onClick={() => actions.delete(a.id)}>
            <Ic name="x" size={16} />
          </button>
          <button className="btn-switch has-ic" onClick={() => actions.askSwitch(a.id)} disabled={isActive}>
            {isActive ? t("btn.current") : <><Ic name="swap" size={14} /> {t("btn.switch")}</>}
          </button>
        </div>
      </div>
      <AccountQuotaSlot
        id={a.id}
        quota={quota}
        plan={plan}
        claimDisabled={claimDisabled}
        onClaim={(id) => actions.claim(id)}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="glyph"><Ic name="empty" size={34} /></div>
      {t("m.emptyTitle")}
      <br />
      {t("m.emptyBody")}
    </div>
  );
}

export default function App() {
  const s = useStore();
  const listRef = useRef(null);
  const scrollCapRef = useRef(null);

  useEffect(() => { boot(); }, []);

  if (store.bootError) {
    return <div className="loading" style={{ color: "var(--red)" }}>{t("common.loadFail", { e: store.bootError })}</div>;
  }
  if (!s.state) return <div className="loading">LOADING</div>;

  const st = s.state;
  const active = st.accounts.find((a) => a.is_active) || null;
  const unsaved = st.live_logged_in && !active;
  const claimableCount = st.accounts.filter((a) => (s.claimable[a.id]?.plans || []).length > 0).length;
  const { claimAllRunning, refreshClaim, claimActive, autoClaimRunning } = runtimeFlags();
  const claimDisabled = claimAllRunning || refreshClaim.running || claimActive || autoClaimRunning;

  // 滚动保活：重绘前记录首个可见行，绘制后复位
  const captureScroll = () => {
    const list = listRef.current;
    if (!list || list.scrollTop === 0) return null;
    const listTop = list.getBoundingClientRect().top;
    for (const row of list.querySelectorAll(".row[data-id]")) {
      if (row.getBoundingClientRect().bottom > listTop) {
        return { id: row.dataset.id, offset: row.getBoundingClientRect().top - listTop, scrollTop: list.scrollTop };
      }
    }
    return null;
  };
  scrollCapRef.current = captureScroll();

  useEffect(() => {
    const cap = scrollCapRef.current;
    const list = listRef.current;
    if (!cap || !list) return;
    const row = list.querySelector(`.row[data-id="${CSS.escape(cap.id)}"]`);
    if (row) {
      const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTop = delta - cap.offset;
    } else {
      list.scrollTop = cap.scrollTop;
    }
  });

  return (
    <>
      <TopBar s={st} unsaved={unsaved} />
      <Toolbar s={st} active={active} unsaved={unsaved} claimableCount={claimableCount} />
      <div className="section-head">
        <h2>{t("m.accounts")}</h2>
        <span className="count">{t("m.count", { count: st.accounts.length })}</span>
      </div>
      <main className="list" ref={listRef}>
        {st.accounts.length === 0 ? <EmptyState /> : st.accounts.map((a) => (
          <AccountRow
            key={a.id}
            a={a}
            quota={s.acctQuota[a.id]}
            plan={s.claimable[a.id]?.plans?.[0] || null}
            claimDisabled={claimDisabled}
          />
        ))}
      </main>
    </>
  );
}
