/**
 * 核心职责：定义剧情卡生命周期的公共词表，供持久状态、模块端口与控制台视图共用。
 * 交互契约：依赖 zod；只声明状态集合与类型，不定义卡片内容、触发条件或效果。
 * 约束与禁忌：新增状态必须同时更新剧情模块状态机与公开视图，禁止在各层各写一套枚举。
 */
import { z } from "zod";

/** 剧情卡生命周期：草稿、已发布、已触发、已撤回。 */
export const scenarioCardStatusSchema = z.enum(["draft", "published", "triggered", "withdrawn"]);

export type ScenarioCardStatus = z.infer<typeof scenarioCardStatusSchema>;
