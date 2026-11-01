// 主题切换的唯一入口：侧边栏快捷钮与设置页共用。
// 状态真身在 <html data-theme> 上（main.jsx 首帧前已应用持久化值），
// 变更时广播 zcs-theme 事件让设置页分段控件同步。
import { getCurrentWindow } from "@tauri-apps/api/window";

// Windows 原生标题栏/窗口主题跟 CSS 主题走；窗口创建时 conf 写死 Dark，
// 靠这里在运行时改。setTheme 需 core:window:allow-set-theme 权限。
export function applyNativeTheme(th) {
  getCurrentWindow().setTheme(th === "light" ? "light" : "dark").catch(() => {});
}

export function currentTheme() {
  return document.documentElement.dataset.theme || "dark";
}

export function setTheme(th) {
  localStorage.setItem("zcs-theme", th);
  document.documentElement.dataset.theme = th;
  applyNativeTheme(th);
  window.dispatchEvent(new Event("zcs-theme"));
}
