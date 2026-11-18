/**
 * 定义 Agent 记忆记录：证据地位、生命周期状态、来源与版本化内容引用。
 * 依赖记忆作用域、内容引用与主体 ID 校验。
 * 禁止在此实现记忆检索、淘汰或合并策略。
 */
import { z } from "zod";
import { contentRefSchema, memoryScopeSchema } from "./frontier";
import { jsonValueSchema } from "./json";
import { idSchemas, principalIdSchema } from "./ids";

/** 记忆分层与用途。 */
export const memoryRecordKindSchema = z.enum([
  "episodic",
  "relation",
  "belief",
  "prospective",
  "core",
  "public",
]);

export type MemoryRecordKind = z.infer<typeof memoryRecordKindSchema>;

/** 记忆生命周期状态。 */
export const memoryRecordStatusSchema = z.enum(["active", "superseded", "expired", "evicted", "retracted"]);

export type MemoryRecordStatus = z.infer<typeof memoryRecordStatusSchema>;

/** 证据地位：已验证事件、转述声称或推断。 */
export const memoryEpistemicSchema = z.enum(["verified-event", "reported-claim", "inference"]);

export type MemoryEpistemic = z.infer<typeof memoryEpistemicSchema>;

/** 有效期区间：validUntilTick 为 null 表示尚未设定失效时刻，且不得早于生效时刻。 */
export const memoryRecordSchema = z
  .object({
    memoryId: idSchemas.mem,
    scope: memoryScopeSchema,
    kind: memoryRecordKindSchema,
    sourceObservationIds: z.array(idSchemas.obs),
    contentRefs: z.array(contentRefSchema),
    status: memoryRecordStatusSchema,
    epistemic: memoryEpistemicSchema,
    releasePolicyId: z.string().min(1),
    validFromTick: z.number().int().nonnegative(),
    validUntilTick: z.number().int().nonnegative().nullable(),
    revision: z.number().int().nonnegative(),
    content: jsonValueSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.validUntilTick !== null && record.validUntilTick < record.validFromTick) {
      context.addIssue({
        code: "custom",
        message: "validUntilTick 不能早于 validFromTick",
        path: ["validUntilTick"],
      });
    }
  });

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

/** 记忆记录的主体归属由 scope 表达，principalId 仅供需要审计主体的调用方使用。 */
export const memoryOwnerSchema = principalIdSchema;
