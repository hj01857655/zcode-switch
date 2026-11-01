import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // cargo 在 Windows 上锁住 target/ 内的 DLL，chokidar 盯到就 EBUSY 崩掉 dev server
    watch: {
      ignored: ["**/src-tauri/target/**", "**/dist/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tailwind v4 的 CSS 基线是 Chrome 111+；Tauri 用常青 WebView2，实际运行时远新于此
    target: "chrome111",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        captcha: resolve(__dirname, "captcha.html"),
      },
      output: {
        // vendor 分包：框架与平台 API 独立缓存，业务变更不使它们失效
        manualChunks: {
          react: ["react", "react-dom", "scheduler"],
          tauri: ["@tauri-apps/api/core", "@tauri-apps/api/event"],
        },
      },
    },
  },
});
