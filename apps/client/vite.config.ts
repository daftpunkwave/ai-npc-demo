/**
 * 把玩家浏览器宿主固定到回环客户端端口，并把相对 API 与 WS 请求代理到服务端端口。
 * 依赖进程环境中的双端端口配置与 React 插件；不启动控制台监听。
 * 禁止自动递增端口、启用宽松文件访问或把服务端密钥注入浏览器包。
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.NPC_SERVER_HOST ?? "127.0.0.1";
const clientPort = Number(process.env.NPC_CLIENT_PORT ?? 5173);
const serverPort = Number(process.env.NPC_SERVER_PORT ?? 3000);
const api = {
  target: `http://${host}:${serverPort}`,
  ws: true,
  changeOrigin: false,
};

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: { "/api": api },
  },
  preview: {
    host,
    port: clientPort,
    strictPort: true,
    proxy: { "/api": api },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
