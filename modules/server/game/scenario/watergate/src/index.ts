/**
 * 汇总剧情模块定义、端口、处理器与状态工具；只导出公共装配入口。
 * 依赖定义、端口、处理器与状态文件。
 * 禁止在这里读取内容或调度卡片。
 */
export const packageName = "@ai-npc/mod-game-scenario-watergate";

export { escalatingScenarioModuleDefinition, scenarioModuleDefinition } from "./definition";
export { createScenarioContributor } from "./contributor";
export { createScenarioPort } from "./port";
export type { ScenarioPort } from "./port";
export {
  readCardState,
  readRunState,
  scenarioCardStateSchema,
  scenarioContaminationSchema,
  scenarioRunStateSchema,
} from "./state";
export type { ScenarioCardState, ScenarioContamination, ScenarioRunState } from "./state";
