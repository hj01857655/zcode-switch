// React 渲染层入口：挂载 App，原生 JS 版 main.js 保留未动（回退切回 index.html 的 script 即可）
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// 右键菜单与快捷键屏蔽逻辑在 ui-react.jsx 副作用里
import "./components/ui-react.jsx";

const root = createRoot(document.getElementById("app"));
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
