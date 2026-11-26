/**
 * 核心职责：为 Agent 上下文与工具集成测试创建由 kernel 解析的隔离小装配、真实 SQLite 与确定性宿主。
 * 交互契约：按压缩实现选择测试装配，启动后只暴露模块公开端口和临时数据目录。
 * 约束与禁忌：不得修改主装配、手工拼接模块实例或跨测试复用数据库。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssemblyDescriptor,
  ContextBuildRequest,
  Json,
  ModuleDefinition,
  StoragePort,
} from "@world-prism/contracts";
import { capabilityIdSchema } from "@world-prism/contracts";
import { createModuleRegistry, resolveRealmPlan, startInstances, type ResolvedRealmPlan, type StartedInstances } from "@world-prism/kernel";
import type { AgentCompressionPort, AgentContextPort, AgentToolViewPort } from "@world-prism/module-sdk";
import type { ContentPack } from "@world-prism/experiment";
import { loadContentPack } from "@world-prism/experiment";
import { orderedBlocksContextDefinition } from "@world-prism/mod-agent-context-ordered-blocks";
import { compressionNoneModuleDefinition } from "@world-prism/mod-agent-compression-none";
import { compressionWindowModuleDefinition } from "@world-prism/mod-agent-compression-window";
import { structuredToolViewModuleDefinition } from "@world-prism/mod-agent-tool-view-structured";
import { gameToolsModuleDefinition, type GameToolsCatalogPort } from "@world-prism/mod-agent-tools-game-tools";
import { storageModuleDefinition } from "@world-prism/mod-platform-storage-sqlite";
import { createFakeHost, type FakeHost } from "./authority-support";

export const testWorldId = "wld-000000000001";
export const testBranchId = "br-000000000001";
export const testRunId = "run-000000000001";
export const testTurnId = "turn-000000000001";
export const testAttemptId = "att-000000000001";
export const testAgentId = "human-independent";

export interface AgentContextToolsHarness {
  readonly host: FakeHost;
  readonly storage: StoragePort;
  readonly started: StartedInstances;
  readonly content: ContentPack;
  readonly context: AgentContextPort;
  readonly compression: AgentCompressionPort;
  readonly toolView: AgentToolViewPort;
  readonly tools: GameToolsCatalogPort;
  dispose(): Promise<void>;
}

function filterPlan(plan: ResolvedRealmPlan, moduleIds: readonly string[]): ResolvedRealmPlan {
  const allowed = new Set(moduleIds);
  return { ...plan, modules: plan.modules.filter((module) => allowed.has(module.moduleId)) };
}

function assemblyFor(content: ContentPack, compressionModule: "agent.compression.none" | "agent.compression.window"): AssemblyDescriptor {
  return {
    schemaVersion: 1,
    assemblyId: "agent-context-tools-kernel-test",
    configs: {
      storage: { dataDir: "__DATA_DIR__", inlineArtifactMaxBytes: 65536 },
      context: { segmentOrder: ["world", "task", "memory", "history", "input"] },
      compressionNone: {},
      compressionWindow: { triggerRatio: 0.8, preserveRecentGroups: 1, targetTokenRatio: 0.6 },
      toolView: { maxListItems: 5, maxTextChars: 120, includeEvidenceRefs: true },
      gameTools: { toolDescriptions: content.prompts.toolDescriptions },
    },
    realms: {
      server: {
        bindings: [
          { capability: capabilityIdSchema.parse("platform.storage"), moduleId: "platform.storage.sqlite", configRef: "storage" },
          { capability: capabilityIdSchema.parse("agent.context"), moduleId: "agent.context.ordered-blocks", configRef: "context" },
          {
            capability: capabilityIdSchema.parse("agent.compression"),
            moduleId: compressionModule,
            configRef: compressionModule === "agent.compression.window" ? "compressionWindow" : "compressionNone",
          },
          { capability: capabilityIdSchema.parse("agent.tool-view"), moduleId: "agent.tool-view.structured", configRef: "toolView" },
          { capability: capabilityIdSchema.parse("agent.tools"), moduleId: "agent.tools.game-tools", configRef: "gameTools" },
        ],
        agentSlots: {
          context: ["agent.context.ordered-blocks"],
          compression: [compressionModule],
          toolView: ["agent.tool-view.structured"],
        },
      },
      client: { bindings: [] },
      console: { bindings: [] },
    },
  };
}

export async function createAgentContextToolsHarness(
  compressionModule: "agent.compression.none" | "agent.compression.window" = "agent.compression.none",
): Promise<AgentContextToolsHarness> {
  const content = loadContentPack("content", "earth-2964-v1");
  const dataDir = mkdtempSync(join(tmpdir(), "agent-context-tools-"));
  const host = createFakeHost();
  const assembly = assemblyFor(content, compressionModule);
  assembly.configs["storage"] = { dataDir, inlineArtifactMaxBytes: 65536 };
  const definitions: readonly ModuleDefinition[] = [
    storageModuleDefinition,
    orderedBlocksContextDefinition,
    compressionNoneModuleDefinition,
    compressionWindowModuleDefinition,
    structuredToolViewModuleDefinition,
    gameToolsModuleDefinition,
  ];
  const registry = createModuleRegistry();
  for (const definition of definitions) registry.register(definition);
  const plan = resolveRealmPlan({ assembly, realm: "server", catalog: registry.snapshot() });
  const storagePlan = filterPlan(plan, ["platform.storage.sqlite"]);
  const storageStarted = await startInstances(storagePlan, { host, scope: {} });
  const storage = storageStarted.instances[0]?.port as StoragePort | undefined;
  if (storage === undefined) throw new Error("Agent context/tool test storage port is missing");
  storage.transact((tx) => {
    tx.rows("worlds").put({
      world_id: testWorldId,
      pack_id: "earth-2964-v1",
      content_version: "0.3.0",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    tx.rows("branches").put({
      branch_id: testBranchId,
      world_id: testWorldId,
      kind: "experiment",
      status: "active",
      parent_branch_id: null,
      forked_at_world_seq: null,
      run_id: testRunId,
      profile_hash: "profile-hash",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });
  const remainingPlan = filterPlan(plan, plan.modules.map((module) => module.moduleId).filter((id) => id !== "platform.storage.sqlite"));
  const started = await startInstances(remainingPlan, {
    host,
    scope: { worldId: testWorldId, branchId: testBranchId, agentId: testAgentId },
    running: storageStarted.instances,
  });
  const ports = new Map([...storageStarted.instances, ...started.instances].map((instance) => [instance.moduleId, instance.port]));
  const context = ports.get("agent.context.ordered-blocks") as AgentContextPort | undefined;
  const compression = ports.get(compressionModule) as AgentCompressionPort | undefined;
  const toolView = ports.get("agent.tool-view.structured") as AgentToolViewPort | undefined;
  const tools = ports.get("agent.tools.game-tools") as GameToolsCatalogPort | undefined;
  if (context === undefined || compression === undefined || toolView === undefined || tools === undefined) {
    await started.dispose();
    await storageStarted.dispose();
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error("Agent context/tool test module port is missing");
  }
  return {
    host,
    storage,
    started: {
      ...started,
      instances: [...storageStarted.instances, ...started.instances],
      dispose: async () => {
        await started.dispose();
        await storageStarted.dispose();
        rmSync(dataDir, { recursive: true, force: true });
      },
    },
    content,
    context,
    compression,
    toolView,
    tools,
    dispose: async () => {
      await started.dispose();
      await storageStarted.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function baseContextRequest(): ContextBuildRequest {
  return {
    session: { worldId: testWorldId, branchId: testBranchId, agentId: testAgentId },
    runId: testRunId,
    turnId: testTurnId,
    attemptId: "att-000000000001",
    phase: "decision",
    targetAudience: ["player-1"],
    frontier: {
      worldSeq: 10,
      worldTick: 20,
      observationSeq: 2,
      perceptionRevision: 1,
      memoryRevision: 1,
      conversationCursor: "conv-000000000001",
      knowledgeGrantRevision: 1,
    },
    profileHash: "profile-hash",
    templateVersion: "1",
    systemIdentity: "system protocol",
    loreSummary: "shared lore",
    worldViewText: "world line",
    affairsText: "task line",
    historyText: "",
    inputText: "input line",
    observations: [{
      observationId: "obs-000000000001",
      scope: { worldId: testWorldId, branchId: testBranchId, agentId: testAgentId },
      observationSeq: 1,
      sourceEventIds: ["evt-000000000001"],
      sourceObservationIds: [],
      occurredAtTick: 19,
      sensedAtTick: 20,
      knownAtTick: 20,
      channel: "witnessed",
      epistemic: "witnessed",
      confidence: 1,
      releasePolicyId: "parties:human-independent,player-1",
      content: { summaryZh: "input line", detail: "input line" },
    }],
    memoryBundle: {
      status: "empty-by-design",
      revision: 1,
      coreBlock: null,
      relationSummary: [],
      items: [],
      candidates: 0,
      dropped: [],
    },
    modelWindowTokens: 8000,
    budget: {
      maxInputTokens: 8000,
      reservedOutputTokens: 1500,
      safetyTokens: 300,
      toolLoopReserveTokens: 1600,
      segmentBudgets: { world: 800, task: 500, memory: 1000, history: 800, input: 400 },
      historyTurns: 12,
      lendUnusedBudget: false,
    },
  };
}

export function testAuth(options: { readonly turnId?: string | null } = {}) {
  return {
    principalId: testAgentId,
    kind: "agent" as const,
    roles: [],
    worldId: testWorldId,
    branchId: testBranchId,
    actingAsAgentId: testAgentId,
    controllerEpoch: 1,
    turnLeaseEpoch: 1,
    turnId: options.turnId === undefined ? testTurnId : options.turnId,
  };
}
