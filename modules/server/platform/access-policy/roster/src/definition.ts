/**
 * 声明 platform.access-policy.roster 的身份、能力与严格配置 schema。
 * 依赖公共契约与 module-sdk；规则实现由 create 动态加载。
 * 禁止在此读取环境变量、打开存储或放宽未知配置键。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const accessPolicyConfigSchema = z
  .object({
    playerCommands: z.array(z.string().min(1)).default([
      "campaign.start",
      "dialogue.say",
      "information.share",
      "agreement.propose",
      "agreement.respond",
      "task.dispatch",
      "task.cancel",
      "policy.set",
    ]),
    consoleRoles: z.array(z.enum(["operator", "researcher", "evaluator"])).default(["operator", "researcher"]),
  })
  .strict();

export type AccessPolicyConfig = z.infer<typeof accessPolicyConfigSchema>;

const definition: ModuleDefinition = {
  id: "platform.access-policy.roster",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.access-policy"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: accessPolicyConfigSchema,
  defaults: accessPolicyConfigSchema.parse({}),
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createAccessPolicyModule } = await import("./plugin");
    return createAccessPolicyModule(input);
  },
};

/** 经 module-sdk 校验的名册权限模块定义。 */
export const accessPolicyModuleDefinition = defineModule(definition);
