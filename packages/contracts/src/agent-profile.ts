/**
 * 定义 Agent profile 的字段 schema 与解析后的公共形状：认知槽位的模块选择、预算、就绪、对白、失败策略与调度。
 * 依赖本包的模块 ID、Agent 槽位与 JSON 值 schema；配置加载器按继承链合并后产出该形状，Agent 运行时只读取它。
 * 禁止在此读取配置文件、合并继承链或补齐缺失槽位。
 */
import { z } from "zod";
import { jsonValueSchema } from "./json";
import { moduleIdSchema, type AgentSlot } from "./modules";

/** 一个 Agent 槽位选择的模块与其配置。 */
export const agentModuleSelectionSchema = z
  .object({
    module: moduleIdSchema,
    config: jsonValueSchema,
  })
  .strict();

/** 单个 turn 与单个 Agent 每日的调用、轮次、工具与 token 上限。 */
export const agentProfileBudgetsSchema = z
  .object({
    maxModelCallsPerTurn: z.number().int().positive(),
    maxDecisionRounds: z.number().int().positive(),
    maxToolCallsPerTurn: z.number().int().positive(),
    maxToolCallsPerRound: z.number().int().positive(),
    maxTurnMs: z.number().int().positive(),
    maxReplans: z.number().int().nonnegative(),
    maxTokensPerAgentPerDay: z.number().int().nonnegative(),
    reserveOutputTokens: z
      .object({
        decision: z.number().int().positive(),
        speech: z.number().int().positive(),
        "memory-maintenance": z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

/** turn 开始前对记忆持久与派生水位的等待要求。 */
export const agentProfileReadinessSchema = z
  .object({
    requireDurable: z.boolean(),
    requireDerived: z.boolean(),
    waitTimeoutMs: z.number().int().positive(),
    onlineDegradeAfterMs: z.number().int().nonnegative(),
  })
  .strict();

/** run 级调度模块选择与其配置。 */
export const agentProfileSchedulingSchema = z
  .object({
    module: moduleIdSchema,
    config: jsonValueSchema,
  })
  .strict();

export type AgentModuleSelection = z.infer<typeof agentModuleSelectionSchema>;

/** 继承链合并后的 Agent profile；sourceChain 按合并顺序（继承链从根到叶，其后是叠加的 patch）记录配置来源。 */
export interface ResolvedAgentProfile {
  readonly profileId: string;
  readonly sourceChain: readonly string[];
  readonly budgets: z.infer<typeof agentProfileBudgetsSchema>;
  readonly readiness: z.infer<typeof agentProfileReadinessSchema>;
  readonly speech: { readonly maxChars: number };
  readonly failurePolicy: "strict" | "online-fallback";
  readonly scheduling: z.infer<typeof agentProfileSchedulingSchema>;
  readonly slots: Readonly<Partial<Record<AgentSlot, AgentModuleSelection>>>;
}
