/**
 * 核心职责：提供共享 ToolDefinition 注册表与按 Agent 冻结的 binding 收窄。
 * 交互契约：调用方提供内容包描述与工具集条目；端口只解析、校验并转换命令 payload。
 * 约束与禁忌：不得执行 executor、持有当前 Agent、访问世界或把绑定写入共享全局状态。
 */
import {
  cleanJsonSchemaForModel,
  type Json,
  type ModuleCreateInput,
  type ModuleInstance,
  type ToolBinding,
  type ToolDefinition,
} from "@world-prism/contracts";
import {
  createStatelessModule,
  type AgentToolsPort,
} from "@world-prism/module-sdk";
import { z } from "zod";
import { gameToolsConfigSchema, type GameToolsConfig } from "./definition";
import { resolveGameToolCommand } from "./command-resolution";
import { commandToolIds, gameToolInputSchemas, type GameToolId } from "./schemas";

interface ToolSpec {
  readonly toolId: GameToolId;
  readonly effect: "query" | "command";
  readonly commandType: string | null;
  readonly permissionProfile: string;
  readonly viewFields: readonly string[];
}

const toolSpecs: readonly ToolSpec[] = [
  { toolId: "world.inspect", effect: "query", commandType: null, permissionProfile: "self-known", viewFields: ["asOfTick", "meters", "allocation", "roads", "characters", "stockpileLevels"] },
  { toolId: "route.inspect", effect: "query", commandType: null, permissionProfile: "self-known", viewFields: ["path", "travelTicks", "risks", "blockedRoads"] },
  { toolId: "task.inspect", effect: "query", commandType: null, permissionProfile: "self-known", viewFields: ["taskId", "taskType", "commandStatus", "taskStatus", "departTick", "nominalCompletionTick", "participants"] },
  { toolId: "conversation.inspect", effect: "query", commandType: null, permissionProfile: "self-known", viewFields: ["lines"] },
  { toolId: "operation.inspect", effect: "query", commandType: null, permissionProfile: "self-known", viewFields: ["receipt", "taskStatus"] },
  { toolId: "message.send", effect: "command", commandType: "speech.commit", permissionProfile: "message-principals", viewFields: ["messageId", "deliverAtTick"] },
  { toolId: "information.share", effect: "command", commandType: "information.share", permissionProfile: "share-held", viewFields: ["shareId", "deliverAtTick"] },
  { toolId: "agreement.propose", effect: "command", commandType: "agreement.propose", permissionProfile: "agreement-personal", viewFields: ["agreementId"] },
  { toolId: "agreement.respond", effect: "command", commandType: "agreement.respond", permissionProfile: "agreement-personal", viewFields: ["agreementStatus"] },
  { toolId: "asset.dispatch", effect: "command", commandType: "task.dispatch", permissionProfile: "dispatch-delegated", viewFields: ["taskId", "departTick"] },
  { toolId: "task.respond", effect: "command", commandType: "task.respond", permissionProfile: "invited-only", viewFields: [] },
  { toolId: "task.cancel", effect: "command", commandType: "task.cancel", permissionProfile: "cancel-own", viewFields: [] },
  { toolId: "policy.set", effect: "command", commandType: "policy.set", permissionProfile: "policy-owner", viewFields: ["oldValue", "newValue"] },
] as const;

const allowedPermissionProfiles: Readonly<Record<GameToolId, readonly string[]>> = {
  "world.inspect": ["self-known"],
  "route.inspect": ["self-known"],
  "task.inspect": ["self-known"],
  "conversation.inspect": ["self-known"],
  "operation.inspect": ["self-known"],
  "message.send": ["message-principals", "message-principals-or-public"],
  "information.share": ["share-held"],
  "agreement.propose": ["agreement-personal", "agreement-faction"],
  "agreement.respond": ["agreement-personal", "agreement-faction"],
  "asset.dispatch": ["dispatch-delegated", "dispatch-faction"],
  "task.respond": ["invited-only"],
  "task.cancel": ["cancel-own"],
  "policy.set": ["policy-owner"],
};

const genericOutputSchema = z.object({}).passthrough();
const toolIds = toolSpecs.map((spec) => spec.toolId);

function jsonSchemaOf(schema: z.ZodType): Json {
  return cleanJsonSchemaForModel(z.toJSONSchema(schema) as unknown as Json) as Json;
}

function buildDefinitions(config: GameToolsConfig): readonly ToolDefinition[] {
  for (const toolId of toolIds) {
    if (config.toolDescriptions[toolId] === undefined) {
      throw new Error(`tool description missing for ${toolId}`);
    }
  }
  return toolSpecs.map((spec) => ({
    toolId: spec.toolId,
    version: "1",
    description: config.toolDescriptions[spec.toolId] as string,
    effect: spec.effect,
    commandType: spec.commandType,
    inputSchema: jsonSchemaOf(gameToolInputSchemas[spec.toolId]),
    outputSchema: jsonSchemaOf(genericOutputSchema),
    viewFields: [...spec.viewFields],
    permissionProfile: spec.permissionProfile,
  }));
}

function definitionKey(toolId: string, version: string): string {
  return `${toolId}@${version}`;
}

export interface GameToolsCatalogPort extends AgentToolsPort {
  bindingFor(agentId: string, toolId: string, version: string): ToolBinding | null;
  validateArguments(toolId: string, args: Json): { readonly ok: true } | { readonly ok: false; readonly error: string };
}

class GameToolsCatalog implements GameToolsCatalogPort {
  private readonly byKey = new Map<string, ToolDefinition>();
  private readonly boundByAgent = new Map<string, readonly ToolBinding[]>();

  constructor(private readonly definitionsValue: readonly ToolDefinition[]) {
    for (const definition of definitionsValue) {
      this.byKey.set(definitionKey(definition.toolId, definition.version), definition);
    }
  }

  bindAgentToolset(input: Parameters<AgentToolsPort["bindAgentToolset"]>[0]): void {
    const seen = new Set<string>();
    const bindings = input.tools.map((entry) => {
      const key = definitionKey(entry.toolId, entry.version);
      if (seen.has(key)) throw new Error(`duplicate tool binding ${key}`);
      seen.add(key);
      const definition = this.byKey.get(key);
      if (definition === undefined) throw new Error(`unknown tool definition ${key}`);
      if (!(toolIds as readonly string[]).includes(entry.toolId)) {
        throw new Error(`unsupported game tool ${entry.toolId}`);
      }
      const allowed = allowedPermissionProfiles[entry.toolId as GameToolId];
      if (!allowed.includes(entry.permissionProfile)) {
        throw new Error(`permission profile ${entry.permissionProfile} is not valid for ${entry.toolId}`);
      }
      if (entry.budgetProfile !== definition.effect) {
        throw new Error(`budget profile ${entry.budgetProfile} does not match ${definition.effect}`);
      }
      return {
        bindingId: `${input.agentId}:${input.toolsetId}:${entry.toolId}@${entry.version}`,
        agentId: input.agentId,
        toolId: entry.toolId,
        version: entry.version,
        permissionProfile: entry.permissionProfile,
        maxCallsPerTurn: entry.budgetProfile === "query" ? 3 : 2,
        viewConstraints: { ...entry.viewConstraints },
      } satisfies ToolBinding;
    });
    this.boundByAgent.set(input.agentId, bindings);
  }

  definitions(): readonly ToolDefinition[] {
    return this.definitionsValue;
  }

  bindingsFor(agentId: string): readonly ToolBinding[] {
    return this.boundByAgent.get(agentId) ?? [];
  }

  definition(toolId: string, version: string): ToolDefinition | null {
    return this.byKey.get(definitionKey(toolId, version)) ?? null;
  }

  bindingFor(agentId: string, toolId: string, version: string): ToolBinding | null {
    return this.bindingsFor(agentId).find((binding) => binding.toolId === toolId && binding.version === version) ?? null;
  }

  validateArguments(toolId: string, args: Json): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    const schema = gameToolInputSchemas[toolId as GameToolId];
    if (schema === undefined) return { ok: false, error: `unknown tool ${toolId}` };
    const parsed = schema.safeParse(args);
    return parsed.success ? { ok: true } : { ok: false, error: parsed.error.message };
  }

  resolveCommand(input: Parameters<AgentToolsPort["resolveCommand"]>[0]): ReturnType<AgentToolsPort["resolveCommand"]> {
    const schema = gameToolInputSchemas[input.toolId as GameToolId];
    if (schema === undefined) return { error: `unknown tool ${input.toolId}` };
    if (!commandToolIds.has(input.toolId as GameToolId)) {
      return { error: `${input.toolId} is not a command tool` };
    }
    return resolveGameToolCommand(input.toolId as GameToolId, input.arguments);
  }
}

export function createGameToolsModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = gameToolsConfigSchema.parse(input.config);
  return createStatelessModule(input, new GameToolsCatalog(buildDefinitions(config)));
}