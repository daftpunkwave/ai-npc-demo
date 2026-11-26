/**
 * 核心职责：为首次启动生成在线世界与 run 的待提交状态：加载名册与 RunSpec、按装配解析 Agent 配置、
 * 冻结 manifest，并给出在时钟 provider 就绪后一次性写入世界、分支、run、别名与初始时钟的事务。
 * 交互契约：由宿主启动编排注入部署级参数（内容包、装配、配置上下文与宿主服务），
 * 返回的 `commit` 只被调用一次；调用方负责在此之前完成全部可能失败的解析。
 * 约束与禁忌：不打开存储、不启动模块、不按当前入参重建已存在的在线 run，也不在事务外写世界状态。
 */
import type { AssemblyDescriptor, HostServices, Json, ModuleDefinition, StoragePort } from "@world-prism/contracts";
import {
  loadRoster,
  loadRunSpec,
  validateRoster,
  validateRunSpec,
  type ConfigLoadContext,
  type ContentPack,
} from "@world-prism/experiment";
import type { GameClockPort } from "@world-prism/module-sdk";
import { resolveAgentConfiguration } from "./agent-configuration";
import type { ResolvedServerAssembly } from "./assembly";
import { buildRunManifest } from "./manifest";
import { usesFixtureModelTransport } from "./model-configuration";
import { generateRunSeed } from "./random";
import type { PendingFirstRun } from "./startup-types";

/** 首次启动的默认 RunSpec 模板；未指定时按决策路径选择在线模板。 */
const defaultRunSpecRef = "online-default";

/** 首次启动的输入；运行选择之外全部来自已解析的启动参数，因此这里不做任何预检。 */
export interface FirstRunInput {
  readonly host: HostServices;
  readonly storage: StoragePort;
  readonly definitions: readonly ModuleDefinition[];
  readonly content: ContentPack;
  readonly contentVersion: string;
  readonly packId: string;
  readonly loadContext: ConfigLoadContext;
  readonly requestedAssembly: AssemblyDescriptor;
  readonly requestedResolved: ResolvedServerAssembly;
  readonly rosterRef: string;
  readonly runSpecRef: string | undefined;
  readonly modelLayoutRef: string | undefined;
}

/**
 * 生成首次启动的待提交状态。
 *
 * 名册与 RunSpec 的解析都在事务之外完成：任一校验失败都不应留下半个在线世界。
 */
export async function prepareFirstRun(input: FirstRunInput): Promise<PendingFirstRun> {
  const { host, storage, content } = input;
  const roster = loadRoster(input.rosterRef, input.loadContext);
  validateRoster(roster.value, content);
  const runSpecRef = input.runSpecRef
    ?? (usesFixtureModelTransport(input.requestedResolved.plan) ? "online-model-test" : defaultRunSpecRef);
  const loaded = loadRunSpec(runSpecRef, input.loadContext, {
    seed: generateRunSeed(),
    moduleAssemblyRef: input.requestedAssembly.assemblyId,
    worldPackRef: input.packId,
    rosterRef: roster.value.rosterId,
    ...(input.modelLayoutRef === undefined ? {} : { modelLayoutRef: input.modelLayoutRef }),
  });
  validateRunSpec(loaded.value, content, roster);
  const agents = await resolveAgentConfiguration({
    assembly: input.requestedResolved,
    roster: roster.value,
    runSpec: loaded.value,
    loadContext: input.loadContext,
    definitions: input.definitions,
    content,
  });
  const sealed = await buildRunManifest({
    runSpec: loaded.value,
    content: { packId: input.packId, contentVersion: input.contentVersion },
    roster: roster.value,
    resolved: input.requestedResolved,
    ...(agents === null ? {} : { agentProfiles: agents.manifest }),
    ...(agents?.models ? { models: agents.models.manifest } : {}),
  });
  const worldId = host.ids("wld");
  const branchId = host.ids("br");
  const runId = host.ids("run");
  const createdAt = host.nowIso();
  return {
    active: {
      worldId,
      branchId,
      assembly: input.requestedAssembly,
      resolved: input.requestedResolved,
      runSpec: loaded.value,
      manifest: sealed.manifest,
      manifestHash: sealed.manifestHash,
      agents,
    },
    commit: (clock: GameClockPort): void => {
      storage.transact((tx) => {
        tx.rows("worlds").put({
          world_id: worldId,
          pack_id: input.packId,
          content_version: input.contentVersion,
          created_at: createdAt,
        });
        tx.rows("branches").put({
          branch_id: branchId,
          world_id: worldId,
          kind: "online",
          status: "active",
          parent_branch_id: null,
          forked_at_world_seq: null,
          run_id: runId,
          profile_hash: null,
          created_at: createdAt,
        });
        tx.rows("runs").put({
          run_id: runId,
          world_id: worldId,
          branch_id: branchId,
          mode: "live",
          status: "running",
          run_spec_json: loaded.value as unknown as Json,
          manifest_json: sealed.manifest as unknown as Json,
          manifest_hash: sealed.manifestHash,
          contaminated: 0,
          evidence_complete: 1,
          created_at: createdAt,
          started_at: createdAt,
          ended_at: null,
        });
        // 初始时钟行由 provider 自己的有效配置写入，宿主不解析或构造 clock 行。
        clock.initializeInTransaction(tx, branchId);
        tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: createdAt });
      });
    },
  };
}
