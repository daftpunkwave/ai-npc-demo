/**
 * 定义配置引用格式与名册 schema：名册把 gameplay 身份绑定到 profile 与 toolset 配置引用。
 * 依赖 zod；只做结构校验，引用能否解析、身份是否存在于内容包由配置加载器交叉检查。
 * 禁止在此读取配置文件或放宽名册的身份上限。
 */
import { z } from "zod";

/** 配置引用：仓库 config/ 下的文件基名或草稿 ID，不能包含路径分隔符。 */
export const configRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "引用只能由字母、数字、点、下划线与连字符组成");

/** 名册中的一个身份绑定：身份 ID、类别与 profile/toolset 引用。 */
export const rosterAgentSchema = z
  .object({
    agentId: z.string().min(1),
    kind: z.enum(["strategic", "character"]),
    profileRef: configRefSchema,
    toolsetRef: configRefSchema,
  })
  .strict();

/** 名册：最多 15 个 gameplay 身份，即序章正式上场人数。 */
export const rosterSchema = z
  .object({
    schemaVersion: z.literal(1),
    rosterId: configRefSchema,
    agents: z.array(rosterAgentSchema).min(1).max(15, "名册最多包含 15 个身份"),
  })
  .strict();

export type Roster = z.infer<typeof rosterSchema>;
export type RosterAgent = z.infer<typeof rosterAgentSchema>;
