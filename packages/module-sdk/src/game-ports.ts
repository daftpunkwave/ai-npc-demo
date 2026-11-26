/**
 * 核心职责：聚合游戏端口与内容索引的全部类型与常量，保持本包的游戏端口公开导出面。
 * 交互契约：各域文件按依赖单向组合；消费方经本包入口或本文件取得完整端口契约。
 * 约束与禁忌：禁止在这里新增类型定义或实现规则；新类型应放入对应的域文件。
 */
export * from "./game-content-index";
export * from "./game-clock-port";
export * from "./game-map-port";
export * from "./game-resources-port";
export * from "./game-world-port";
export * from "./game-actions-port";
export * from "./game-agreements-port";
export * from "./game-scenario-port";
export * from "./game-comms-port";
export * from "./game-port-binding";

export type { ResourceLevel, ScenarioCardStatus } from "@world-prism/contracts";
