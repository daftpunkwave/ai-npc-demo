/**
 * 定义库存聚合状态 schema 与读取助手。
 * 依赖 zod 与 module-sdk 的 WorldTx；状态只能由资源模块写入。
 * 禁止在这里执行预留、扣减或计算展示等级。
 */
import { DomainError, resourceAmountsSchema } from "@world-prism/contracts";
import type { WorldTx } from "@world-prism/module-sdk";
import { z } from "zod";

export const stockpileStateSchema = z
  .object({
    stockpileId: z.string().min(1),
    nodeId: z.string().min(1),
    ownerFactionId: z.string().min(1),
    amount: resourceAmountsSchema,
    reserved: resourceAmountsSchema,
    baseline: resourceAmountsSchema,
    reservations: z
      .array(
        z
          .object({
            taskId: z.string().min(1),
            amount: resourceAmountsSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.reserved.supply > state.amount.supply) {
      context.addIssue({ code: "custom", message: "供给预留不能超过库存", path: ["reserved", "supply"] });
    }
    if (state.reserved.energy > state.amount.energy) {
      context.addIssue({ code: "custom", message: "能源预留不能超过库存", path: ["reserved", "energy"] });
    }
    if (state.reserved.medical > state.amount.medical) {
      context.addIssue({ code: "custom", message: "医疗材料预留不能超过库存", path: ["reserved", "medical"] });
    }
    const summed = state.reservations.reduce(
      (total, entry) => ({
        supply: total.supply + entry.amount.supply,
        energy: total.energy + entry.amount.energy,
        medical: total.medical + entry.amount.medical,
      }),
      { supply: 0, energy: 0, medical: 0 },
    );
    if (
      summed.supply !== state.reserved.supply ||
      summed.energy !== state.reserved.energy ||
      summed.medical !== state.reserved.medical
    ) {
      context.addIssue({ code: "custom", message: "预留明细之和必须等于预留总量", path: ["reservations"] });
    }
  });

export type StockpileState = z.infer<typeof stockpileStateSchema>;

/** 读取并校验库存聚合；缺失返回 null，损坏直接报错。 */
export function readStockpile(tx: WorldTx, stockpileId: string): StockpileState | null {
  const record = tx.get<unknown>("stockpile", stockpileId);
  if (record === null) {
    return null;
  }
  const parsed = stockpileStateSchema.safeParse(record.state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `库存 ${stockpileId} 的状态不合法`, {
      details: { stockpileId },
    });
  }
  return parsed.data;
}
