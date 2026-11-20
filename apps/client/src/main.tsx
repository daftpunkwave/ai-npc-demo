/**
 * 玩家端浏览器入口：挂载 React 根并导入模块共享的布局样式。
 * 依赖 React DOM 与宿主 bootstrap；不直接启动网络传输或读取环境密钥。
 * 禁止在此实现游戏规则、API 路由或模块选择逻辑。
 */
import { createRoot } from "react-dom/client";
import { ClientBootstrap } from "./host/bootstrap";
import "./styles/index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("玩家端缺少 #root 挂载节点");
}
createRoot(root).render(<ClientBootstrap />);
