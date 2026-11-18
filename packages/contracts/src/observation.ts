/**
 * 定义 Agent 观察记录：来源、获知方式、置信度、可见时间与内容。
 * 依赖记忆作用域、主体与事件 ID 校验。
 * 禁止把记忆的证据地位与观察的获知方式混为同一个枚举。
 */
import { z } from "zod";
import { memoryScopeSchema } from "./frontier";
import { jsonValueSchema } from "./json";
import { idSchemas } from "./ids";

/** 获知方式：亲历、转述或推断。 */
export const observationEpistemicSchema = z.enum(["witnessed", "reported", "inferred"]);

export type ObservationEpistemic = z.infer<typeof observationEpistemicSchema>;

/**
 * 观察的时间顺序必须为 occurredAtTick <= sensedAtTick <= knownAtTick，
 * confidence 必须是 0 到 1 的有限数；运行中亲历的观察来源不能为空。
 */
export const agentObservationSchema = z
  .object({
    observationId: idSchemas.obs,
    scope: memoryScopeSchema,
    observationSeq: z.number().int().nonnegative(),
    sourceEventIds: z.array(idSchemas.evt),
    sourceObservationIds: z.array(idSchemas.obs),
    occurredAtTick: z.number().int().nonnegative(),
    sensedAtTick: z.number().int().nonnegative(),
    knownAtTick: z.number().int().nonnegative(),
    channel: z.string().min(1),
    epistemic: observationEpistemicSchema,
    confidence: z.number().min(0).max(1),
    releasePolicyId: z.string().min(1),
    content: jsonValueSchema,
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.occurredAtTick > observation.sensedAtTick) {
      context.addIssue({
        code: "custom",
        message: "occurredAtTick 不能晚于 sensedAtTick",
        path: ["sensedAtTick"],
      });
    }
    if (observation.sensedAtTick > observation.knownAtTick) {
      context.addIssue({
        code: "custom",
        message: "sensedAtTick 不能晚于 knownAtTick",
        path: ["knownAtTick"],
      });
    }
    if (
      observation.epistemic === "witnessed" &&
      observation.sourceEventIds.length === 0 &&
      observation.sourceObservationIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "亲历观察必须带有来源事件或来源观察",
        path: ["sourceEventIds"],
      });
    }
  });

export type AgentObservation = z.infer<typeof agentObservationSchema>;
