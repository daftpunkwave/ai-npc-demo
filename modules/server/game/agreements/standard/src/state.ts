/**
 * 定义协议聚合状态：当事人、条款、回复、履约进度与关闭原因。
 * 依赖公共契约的条款 schema；只做状态校验与读取。
 * 禁止在这里执行条款有效性检查或履约订阅。
 */
import { termSchema } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

export const agreementStateSchema = z
  .object({
    agreementId: z.string().min(1),
    version: z.number().int().positive(),
    proposerId: z.string().min(1),
    parties: z.array(z.string().min(1)).min(2),
    terms: z.array(termSchema).min(1),
    responses: z.record(z.string(), z.enum(["accept", "reject", "counter"])),
    status: z.enum(["proposed", "active", "fulfilled", "rejected", "superseded", "expired", "breached"]),
    createdAtTick: z.number().int().nonnegative(),
    activatedAtTick: z.number().int().nonnegative().nullable(),
    expiresAtTick: z.number().int().nonnegative(),
    supersedesId: z.string().min(1).nullable(),
    supersededBy: z.string().min(1).nullable(),
    fulfilledTerms: z.array(z.number().int().nonnegative()),
    breachedTerms: z.array(z.number().int().nonnegative()),
    progress: z.array(z.number().nonnegative()),
  })
  .strict();

export type AgreementState = z.infer<typeof agreementStateSchema>;

/** 读取并校验协议聚合；缺失返回 null，损坏直接报错。 */
export function readAgreementState(tx: WorldTx, agreementId: string): AgreementState | null {
  const record = tx.get<unknown>("agreement", agreementId);
  if (record === null) {
    return null;
  }
  const parsed = agreementStateSchema.safeParse(record.state);
  if (!parsed.success) {
    throw new Error(`协议聚合 ${agreementId} 不合法`);
  }
  return parsed.data;
}
