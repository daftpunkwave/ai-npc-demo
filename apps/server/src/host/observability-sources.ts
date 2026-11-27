/**
 * 核心职责：用各数据所有者的类型化查询组合观测数据源端口，供宿主绑定到观测 provider。
 * 交互契约：领域事件、命令回执与分支登记经 authority；turn 证据、Agent 状态与调试触发经 agent-runtime；
 *   生命周期审计与 artifact 正文经 module-sdk；run 的冻结名册由宿主读取；角色位置经世界模块只读端口，
 *   当前 tick 经时钟 provider。read 回调内的全部查询共享同一个存储事务。
 * 约束与禁忌：只做组合与跨所有者拼接，不在此书写他人表的 SQL；除调试唤醒外不写入。
 */
import {
  latestEventSeq,
  listEventsAfter,
  listTimelineEvents,
  readBranch,
  readCommandReceipt,
} from "@world-prism/authority";
import {
  countTurnToolCalls,
  listAgentRuntimeStates,
  listMemoryRecordVersions,
  listObservationPage,
  listPendingMaintenance,
  listStartedModelAttemptTimes,
  listTurnModelAttempts,
  listTurnModelUsages,
  listTurnRuns,
  listTurnToolCalls,
  listTurnTriggerKinds,
  readMemoryWatermark,
  readPerceptionRevision,
  readSchedulerQueue,
  readTurnRun,
} from "@world-prism/agent-runtime";
import type { Json, StoragePort, StorageTransaction } from "@world-prism/contracts";
import {
  listLifecycleTimeline,
  readArtifactBody,
  type GameWorldPort,
  type ObservabilitySourceReader,
  type ObservabilitySources,
  type ObservedAgentState,
} from "@world-prism/module-sdk";
import { requestDebugWake, type DebugWakeDependencies } from "./debug-wake";
import { rosterAgentKindsOf } from "./manifest";

export interface ObservabilitySourcesInput extends DebugWakeDependencies {
  readonly storage: StoragePort;
  /** 在调用方事务内按分支作用域绑定世界模块只读端口；角色聚合归世界模块，宿主不读其存储行。 */
  readonly worldIn: (
    tx: StorageTransaction,
    scope: { readonly branchId: string; readonly worldId: string },
  ) => Pick<GameWorldPort, "character">;
}

/** run 的冻结 manifest；run 不存在或尚未冻结时为 null。 */
function frozenManifestOf(tx: StorageTransaction, runId: string): Json {
  const manifest = tx.rows("runs").get({ run_id: runId })?.["manifest_json"];
  return manifest === undefined || manifest instanceof Uint8Array ? null : manifest;
}

/**
 * 分支上冻结名册登记的 Agent 状态：激活与运行时状态来自 agent-runtime，只保留分支所属 run 的名册登记的 Agent，
 * 再经世界模块补齐角色位置；没有名册登记的 Agent 时不绑定世界端口。
 */
function agentStatesIn(
  tx: StorageTransaction,
  branchId: string,
  worldIn: ObservabilitySourcesInput["worldIn"],
): readonly ObservedAgentState[] {
  const states = listAgentRuntimeStates(tx, branchId);
  if (states.length === 0) return [];
  const branch = readBranch(tx, branchId);
  const runId = branch?.runId ?? null;
  if (branch === null || runId === null) return [];
  const kinds = rosterAgentKindsOf(frozenManifestOf(tx, runId));
  const rostered = states.filter((state) => kinds.has(state.agentId));
  if (rostered.length === 0) return [];
  const world = worldIn(tx, { branchId, worldId: branch.worldId });
  return rostered.map((state) => ({
    ...state,
    rosterKind: kinds.get(state.agentId) ?? null,
    nodeId: world.character(state.agentId)?.nodeId ?? null,
  }));
}

function readerIn(tx: StorageTransaction, input: ObservabilitySourcesInput): ObservabilitySourceReader {
  return {
    domainEventTimeline: (query) => listTimelineEvents(tx, query),
    domainEventsAfter: (branchId, afterSeq) => listEventsAfter(tx, branchId, afterSeq),
    latestWorldSeq: (branchId) => latestEventSeq(tx, branchId),
    commandStatus: (branchId, principalId, commandId) =>
      readCommandReceipt(tx, branchId, principalId, commandId)?.commandStatus ?? null,
    lifecycleTimeline: (query) => listLifecycleTimeline(tx, query),
    branchWorldId: (branchId) => readBranch(tx, branchId)?.worldId ?? null,
    agentStates: (branchId) => agentStatesIn(tx, branchId, input.worldIn),
    turnRuns: (filter) => listTurnRuns(tx, filter),
    turnRun: (turnId) => readTurnRun(tx, turnId),
    turnTriggerKinds: (turnIds) => listTurnTriggerKinds(tx, turnIds),
    turnToolCallCounts: (turnIds) => countTurnToolCalls(tx, turnIds),
    turnModelUsages: (turnIds) => listTurnModelUsages(tx, turnIds),
    turnModelAttempts: (runId, turnId) => listTurnModelAttempts(tx, runId, turnId),
    turnToolCalls: (runId, turnId) => listTurnToolCalls(tx, runId, turnId),
    schedulerQueue: (branchId) => readSchedulerQueue(tx, branchId),
    startedModelAttemptTimes: (branchId) => listStartedModelAttemptTimes(tx, branchId),
    pendingMaintenance: (branchId) => listPendingMaintenance(tx, branchId),
    memoryWatermark: (branchId, agentId) => readMemoryWatermark(tx, branchId, agentId),
    perceptionRevision: (branchId, agentId) => readPerceptionRevision(tx, branchId, agentId),
    memoryRecords: (branchId, agentId) => listMemoryRecordVersions(tx, branchId, agentId),
    observations: (branchId, agentId, afterSeq, limit) =>
      listObservationPage(tx, { branchId, agentId, afterSeq, limit }),
  };
}

/** 组合观测数据源端口；每次 read 与调试唤醒各自开启一个存储事务，artifact 正文在事务外按登记方式取回。 */
export function createObservabilitySources(input: ObservabilitySourcesInput): ObservabilitySources {
  return {
    read: (query) => input.storage.transact((tx) => query(readerIn(tx, input))),
    artifactBody: (artifactId) => readArtifactBody(input.storage, artifactId),
    requestDebugWake: (wake) => {
      input.storage.transact((tx) => {
        requestDebugWake(tx, wake, input);
      });
    },
  };
}
