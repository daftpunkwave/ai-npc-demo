/**
 * 控制台浏览器入口：挂载 React 根并导入研究工作台样式。
 * 依赖 React DOM 与宿主 bootstrap；不启动独立 Web 端口。
 * 禁止在此读取模型密钥或直接访问数据库。
 */
import { createRoot } from "react-dom/client";
import { ConsoleBootstrap } from "./host/bootstrap";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("控制台缺少 #root 挂载节点");
}
createRoot(root).render(<ConsoleBootstrap />);
