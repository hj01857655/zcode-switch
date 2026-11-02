// updater.js — 应用内更新的共享逻辑（关于页交互 UI 与启动静默检查共用）
// 端点与公钥配置见 src-tauri/tauri.conf.json plugins.updater
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "../components/ui-bus.js";
import { t } from "./i18n.js";

// 启动后静默检查：只在「确实有新版本」时弹一次提示，用户可自行去关于页安装。
// 失败/无更新一律吞掉——首个签名版本发布前端点必 404，网络抖动也常见，
// 这些都不该在开机时打扰用户，故不提示、不重试、不进 store。
export async function silentUpdateCheck() {
  try {
    const u = await check();
    if (u) toast(t("u.foundToast", { ver: u.version }), "ok", t("u.foundToastHint"));
  } catch {
    // 静默：endpoint 404 / 离线 / 超时都不处理，下次启动再试
  }
}

// 原始 Rust 错误串映射成中文短句；未知形态兜底返回原文，便于用户/开发者看到真实报错去排查
export function updateErrText(err) {
  const s = String(err).toLowerCase();
  if (/signature|verify|minisign|invalid sig|trusted comment/.test(s)) return t("u.errSignature");
  if (/send request|connection|dns|timed out|eof|offline|network|failed to (fetch|connect)/.test(s)) return t("u.errNetwork");
  if (/404|not found|status code|did not respond|no update|unexpected .*json|deserializ/.test(s)) return t("u.errEndpoint");
  if (/download|content.?length|chunk|extract|install|write/.test(s)) return t("u.errDownload");
  return String(err);
}
