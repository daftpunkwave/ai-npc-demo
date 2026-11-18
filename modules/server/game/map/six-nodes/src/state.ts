/**
 * 定义地图模块自己的聚合状态 schema 与读取助手。
 * 依赖 zod 与 module-sdk 的 WorldTx 类型；状态只允许由地图模块写入。
 * 禁止在这里读取静态道路属性或执行路径查询。
 */
import { DomainError } from "@ai-npc/contracts";
import type { WorldTx } from "@ai-npc/module-sdk";
import { z } from "zod";

export const roadStateSchema = z
  .object({
    roadId: z.string().min(1),
    status: z.enum(["open", "restricted", "closed"]),
  })
  .strict();

export const passageGrantStateSchema = z
  .object({
    roadId: z.string().min(1),
    granteeFactionId: z.string().min(1),
    untilTick: z.number().int().nonnegative(),
  })
  .strict();

export type RoadState = z.infer<typeof roadStateSchema>;
export type PassageGrantState = z.infer<typeof passageGrantStateSchema>;

/** 读取并校验地图聚合；损坏的状态直接报错，不按默认值静默修复。 */
export function readMapState<T>(tx: WorldTx, aggregateType: string, aggregateId: string, schema: z.ZodType<T>): {
  readonly version: number;
  readonly state: T;
} | null {
  const record = tx.get<unknown>(aggregateType, aggregateId);
  if (record === null) {
    return null;
  }
  const parsed = schema.safeParse(record.state);
  if (!parsed.success) {
    throw new DomainError("invalid-state", `地图聚合 ${aggregateType}:${aggregateId} 不合法`, {
      details: { aggregateType, aggregateId },
    });
  }
  return { version: record.version, state: parsed.data };
}
