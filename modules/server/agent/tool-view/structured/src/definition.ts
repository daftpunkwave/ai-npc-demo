/**
 * 核心职责：声明保留稳定 envelope、字段白名单与有限列表的结构化工具视图能力。
 * 交互契约：提供 agent 级 agent.tool-view 能力，配置只降低展示细度。
 * 约束与禁忌：不得改变执行状态、receipt、失败原因或权限集合。
 */
import { capabilityIdSchema, type ModuleDefinition } from "@ai-npc/contracts";
import { defineModule } from "@ai-npc/module-sdk";
import { z } from "zod";

export const structuredToolViewConfigSchema = z
  .object({
    maxListItems: z.number().int().positive(),
    maxTextChars: z.number().int().positive(),
    includeEvidenceRefs: z.boolean(),
  })
  .strict();

export type StructuredToolViewConfig = z.infer<typeof structuredToolViewConfigSchema>;

const definition: ModuleDefinition = {
  id: "agent.tool-view.structured",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "agent",
  provides: [{
    capability: capabilityIdSchema.parse("agent.tool-view"),
    cardinality: "exactly-one",
    instanceScope: "agent",
  }],
  requires: [],
  requiresRemote: [],
  configSchema: structuredToolViewConfigSchema,
  defaults: { maxListItems: 5, maxTextChars: 120, includeEvidenceRefs: true },
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => {
    const { createStructuredToolViewModule } = await import("./plugin");
    return createStructuredToolViewModule(input);
  },
};

export const structuredToolViewModuleDefinition = defineModule(definition);
