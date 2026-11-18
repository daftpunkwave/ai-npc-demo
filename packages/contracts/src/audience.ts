/**
 * 定义事件的受众声明。
 * 依赖节点 ID 与主体 ID 校验；供事件信封、观察与投影共用。
 * 禁止在此计算谁能实际获知，硬 ACL 由宿主按受众规则求值。
 */
import { z } from "zod";
import { nodeIdSchema, principalIdSchema } from "./ids";

/**
 * 受众声明：公开、某节点在场、明确主体名单、派系或仅研究视图。
 * system 受众不产生任何 gameplay 主体的观察。
 */
export const audienceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public") }).strict(),
  z.object({ kind: z.literal("node"), nodeId: nodeIdSchema }).strict(),
  z.object({ kind: z.literal("principals"), ids: z.array(principalIdSchema).min(1) }).strict(),
  z.object({ kind: z.literal("faction"), factionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);

export type AudienceSpec = z.infer<typeof audienceSpecSchema>;
