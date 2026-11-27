/**
 * 定义 RunSpec 的严格 schema，作为 run 配置文件加载的字段契约。
 * 依赖 zod 与公共契约的配置引用格式；只做结构校验，引用存在性由加载器与交叉检查负责。
 * 禁止在此读取文件、解析 env: 引用或填充运行时生成的 seed。
 */
import { configRefSchema } from "@world-prism/contracts";
import { z } from "zod";

/**
 * run 的初始状态来源。当前只支持冷启动：快照与记忆重建需要实验执行器消费，
 * 而执行器尚未实现。在这里接受它们会让「声明了 snapshot/rebuild」的配置
 * 静默按冷启动跑完，因此改为显式拒绝，待执行器落地后连同消费路径一起加回。
 */
const initialStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cold-start") }).strict(),
]);

/** 实验变体：profile patch 列表与可选的 Agent 范围。 */
const variantSchema = z
  .object({
    id: configRefSchema,
    profilePatchRefs: z.array(configRefSchema),
    agentIds: z.array(z.string().min(1)).nullable(),
  })
  .strict();

/** 剧本输入：脚本引用与分支；branch 省略时由执行器决定。 */
const scriptSelectionSchema = z
  .object({
    scriptRef: configRefSchema,
    branch: configRefSchema.optional(),
  })
  .strict();

/**
 * run 的运行模式。当前只有 live（在线自由输入）与 closed-loop（实验分支）有一条真实的
 * 执行路径；audit 与 open-loop 依赖尚未实现的实验执行器，没有消费者，因此不再接受。
 */
export const runModeSchema = z.enum(["live", "closed-loop"]);

/** 时钟实现声明的运行方式。 */
export const clockKindSchema = z.enum(["controlled", "realtime"]);

/** 失败策略：严格实验或在线已声明降级。 */
export const failurePolicySchema = z.enum(["strict", "online-fallback"]);

/** RunSpec：一次 run 的完整选择与冻结输入。 */
export const runSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: configRefSchema,
    /**
     * 归属的实验标识；由实验展开写入，普通单 run 规格没有该字段。
     * 评估读取按它归组，不再从 `seed` 文本推断——两者是独立配置项，可以不同名。
     */
    experimentId: configRefSchema.optional(),
    moduleAssemblyRef: configRefSchema,
    worldPackRef: configRefSchema,
    scenarioRef: configRefSchema,
    rosterRef: configRefSchema,
    modelLayoutRef: configRefSchema,
    seed: z.string().min(1),
    player: z
      .object({
        principalId: z.string().min(1),
        factionId: z.string().min(1).nullable(),
      })
      .strict(),
    mode: runModeSchema,
    initialState: initialStateSchema,
    variant: variantSchema.nullable(),
    script: scriptSelectionSchema.nullable(),
    clock: z.object({ kind: clockKindSchema }).strict(),
    budget: z
      .object({
        maxTokens: z.number().int().nonnegative().nullable(),
        maxCost: z.number().nonnegative().nullable(),
      })
      .strict(),
    failurePolicy: failurePolicySchema,
  })
  .strict();

export type RunSpec = z.infer<typeof runSpecSchema>;
export type RunMode = z.infer<typeof runModeSchema>;
export type ClockKind = z.infer<typeof clockKindSchema>;
export type FailurePolicy = z.infer<typeof failurePolicySchema>;
