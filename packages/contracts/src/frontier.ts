/**
 * 定义 Agent 的冻结输入边界、记忆作用域与版本化内容引用。
 * 依赖 zod 的基础校验，不依赖任何领域模块。
 * 禁止在此读取世界状态或推进边界；边界由宿主在 turn 开始时冻结。
 */
import { z } from "zod";
import { principalIdSchema } from "./ids";

/** 记忆作用域：世界、分支与主体的三元组。 */
export const memoryScopeSchema = z
  .object({
    worldId: z.string().min(1),
    branchId: z.string().min(1),
    agentId: principalIdSchema,
  })
  .strict();

export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/** 版本化内容引用：内容包条目及其版本，可再定位到其中一个条目。 */
export const contentRefSchema = z
  .object({
    contentId: z.string().min(1),
    contentVersion: z.string().min(1),
    itemId: z.string().min(1).optional(),
  })
  .strict();

export type ContentRef = z.infer<typeof contentRefSchema>;

/**
 * 冻结输入边界：同一 worldSeq 下仍可能晚到的观察、感知与知识授权分别冻结。
 * conversationCursor 为 null 表示该主体当前没有可用会话游标。
 */
export const inputFrontierSchema = z
  .object({
    worldSeq: z.number().int().nonnegative(),
    worldTick: z.number().int().nonnegative(),
    observationSeq: z.number().int().nonnegative(),
    perceptionRevision: z.number().int().nonnegative(),
    memoryRevision: z.number().int().nonnegative(),
    conversationCursor: z.string().min(1).nullable(),
    knowledgeGrantRevision: z.number().int().nonnegative(),
  })
  .strict();

export type InputFrontier = z.infer<typeof inputFrontierSchema>;
