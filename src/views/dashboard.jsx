// 仪表盘页：全局状态一览（账号 / 可领取 / ZCode / 网关 / 自动领取）+ 各账号额度概览。
// 数据全部取自 store（sweep 自动刷新）与 gateway_status，不新增后端命令。
import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n.js";
import { Ic } from "../components/iconsx.jsx";
import { store, subscribe, getVersion, accountName } from "../lib/store.js";
import { expireInfo, tierBadges } from "../lib/quotaView.js";
import { TierBadges } from "../components/QuotaView.jsx";

function useStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return store;
}

function Card({ label, value, cls, ic }) {
  return (
    <div className={"dash-card" + (cls === "ok" ? " state-ok" : "")}>
      <div className="dash-label">{ic ? <Ic name={ic} size={12} /> : null}{label}</div>
      <div className={"dash-value" + (cls ? " " + cls : "")}>{value}</div>
    </div>
  );
}

export default function DashboardPage() {
  useStore();
  const [gw, setGw] = useState(null);

  useEffect(() => {
    let alive = true;
    invoke("gateway_status")
      .then((v) => { if (alive) setGw(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const s = store.state || {};
  const accounts = s.accounts || [];
  const active = accounts.find((a) => a.is_active) || null;
  const claimable = accounts.filter((a) => (store.claimable[a.id]?.plans || []).length > 0).length;
  const gwOn = !!gw?.running;

  return (
    <div className="settings">
      <div className="section-head">
        <h2>{t("d.menu")}</h2>
      </div>
      <div className="dash-cards">
        <Card label={t("d.accCount")} value={accounts.length} ic="list" />
        <Card
          label={t("d.claimable")}
          value={claimable ? t("d.claimableN", { n: claimable }) : t("d.claimableNone")}
          cls={claimable ? "ok" : "dim"}
          ic="gift"
        />
        <Card
          label={t("d.zcodeState")}
          value={<><Ic name="power" size={14} /> {s.zcode_running ? t("d.zcodeRun") : t("d.zcodeStop")}</>}
          cls={s.zcode_running ? "ok" : "dim"}
          ic="play"
        />
        <Card
          label={t("d.gateway")}
          value={gwOn ? t("d.gatewayOn", { port: gw.port ?? 8081 }) : t("d.gatewayOff")}
          cls={gwOn ? "ok" : "dim"}
          ic="swap"
        />
        <Card
          label={t("d.autoClaim")}
          value={s.auto_claim ? t("d.on") : t("d.off")}
          cls={s.auto_claim ? "ok" : "dim"}
          ic="refresh"
        />
        <Card label={t("d.current")} value={active?.name || t("d.none")} cls={active ? "" : "dim"} ic="check" />
      </div>
      <div className="dash-list">
        {accounts.map((a) => {
          const q = store.acctQuota[a.id]?.data;
          const exp = expireInfo(q?.plan_expire, q?.plan_starts);
          return (
            <div key={a.id} className={"dash-row" + (a.is_active ? " active" : "")}>
              <span className="dash-row-name" title={a.id}>{a.name}</span>
              <TierBadges pairs={tierBadges(q)} />
              <span className="dash-row-meta">
                {exp ? t("q.validUntil", { date: exp.text }) : t("q.unknown")}
              </span>
            </div>
          );
        })}
        {accounts.length === 0 ? <div className="dash-empty">{t("m.emptyTitle")}</div> : null}
      </div>
    </div>
  );
}
