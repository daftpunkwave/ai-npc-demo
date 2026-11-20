/**
 * 把控制台构建到服务端静态目录，并固定使用 /console/ 基路径。
 * 依赖 React/Vite 构建工具；不启动独立监听或代理到服务端。
 * 禁止把控制台输出到第三个 Web 服务或注入服务端密钥。
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/console/",
  build: {
    outDir: "../server/console-static",
    emptyOutDir: true,
  },
});
