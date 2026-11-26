/**
 * 核心职责：识别在线 run 的能力闭包升级场景并执行显式迁移；迁移在单事务内派生新分支与新 run，
 * 并提供启动失败后恢复在线入口的补偿事务。
 * 交互契约：依赖 StoragePort 的 forkBranch 端口、宿主 ID 与时间服务、冻结 manifest 的规范化哈希。
 * 约束与禁忌：不修改源 run 行与源 manifest；源分支只允许两处让位语义变更（status 置 archived，
 * 与重新开局的分支让位一致）；迁移事务内校验别名仍指向读取时的源分支，过时入口直接拒绝；
 * 不可迁移的失败（数据损坏、内容版本不一致、非能力闭包差异）不得进入迁移路径。
 */
import { DomainError, canonicalJson, type HostServices, type Json, type StoragePort, type StorageTransaction } from "@world-prism/contracts";
import type { RunManifest } from "./manifest";
import type { OnlineEntry } from "./online-entry";

/**
 * 在线 run 的冻结 manifest 无法按当前模块目录复算：能力闭包已升级，需要显式迁移。
 * 携带 runId 与失败细节，供启动编排区分「需要迁移」与不可恢复的数据损坏。
 */
export class OnlineRunMigrationRequiredError extends Error {
  readonly runId: string;
  readonly branchId: string;

  constructor(input: { readonly runId: string; readonly branchId: string; readonly detail: string }) {
    super(
      `在线 run ${input.runId} 的冻结 manifest 无法按当前模块目录复算（能力闭包已升级）：${input.detail}。` +
        "源 run 与分支保持原样，未被修改。设置 NPC_MIGRATE_ONLINE_RUN=1 重启以执行显式迁移" +
        "（从源分支派生新分支与新 run，沿用原 seed 与 RunSpec，按当前能力闭包冻结新 manifest），" +
        "或回退到创建该 run 的代码版本。",
    );
    this.name = "OnlineRunMigrationRequiredError";
    this.runId = input.runId;
    this.branchId = input.branchId;
  }
}

/** 迁移结果：新 run 与新分支的标识；源 run 与源 manifest 保持原样。 */
export interface MigratedOnlineRun {
  readonly runId: string;
  readonly branchId: string;
  /** 源分支被归档前的状态，供启动失败补偿原样写回。 */
  readonly sourceBranchStatus: "active" | "paused";
}

/** 迁移输入：在线入口、冻结 RunSpec 原文与按当前能力闭包重建的 manifest。 */
export interface MigrateOnlineRunInput {
  readonly storage: StoragePort;
  /** 宿主服务：生成 runId/branchId 与时间戳。 */
  readonly host: Pick<HostServices, "ids" | "nowIso">;
  readonly online: OnlineEntry;
  readonly runSpec: Json;
  readonly manifest: RunManifest;
  readonly manifestHash: string;
}

function numericCell(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** 规范化 JSON 等值比较；undefined 与 null 都表示「字段不存在」。 */
function canonicalFieldEquals(frozen: unknown, rebuilt: unknown): boolean {
  return canonicalJson((frozen ?? null) as Json) === canonicalJson((rebuilt ?? null) as Json);
}

/**
 * 校验冻结 manifest 与重建 manifest 的差异只落在装配能力闭包上：
 * seed、RunSpec 选择、内容版本、名册、Agent 槽位、profile 与模型配置任一变化都超出升级范围；
 * assembly 内部只允许绑定集的新增与移除，保留绑定的模块版本或配置摘要变化属于配置漂移，
 * 此时迁移会把改动后的配置应用到历史世界，必须拒绝而不是迁移。
 */
export function assertMigrationScopeIsCapabilityClosure(frozenManifestValue: Json, rebuilt: RunManifest): void {
  const frozen = frozenManifestValue as Readonly<Record<string, Json>>;
  const mismatches: string[] = [];
  if (frozen["seed"] !== rebuilt.seed) {
    mismatches.push("seed");
  }
  for (const field of ["selection", "content", "roster", "agentSlots", "agentProfiles", "models"] as const) {
    if (!canonicalFieldEquals(frozen[field], rebuilt[field])) {
      mismatches.push(field);
    }
  }
  const frozenAssembly = frozen["assembly"];
  const frozenModules = moduleEntries(
    typeof frozenAssembly === "object" && frozenAssembly !== null
      ? (frozenAssembly as Readonly<Record<string, unknown>>)["modules"]
      : undefined,
  );
  const frozenById = new Map(frozenModules.map((module) => [module.moduleId, module]));
  for (const module of rebuilt.assembly.modules) {
    const frozenModule = frozenById.get(module.moduleId);
    if (frozenModule === undefined) {
      continue;
    }
    if (
      frozenModule.configHash !== module.configHash ||
      frozenModule.version !== module.version ||
      frozenModule.apiVersion !== module.apiVersion
    ) {
      mismatches.push(`assembly.modules.${module.moduleId}`);
    }
  }
  if (mismatches.length > 0) {
    throw new DomainError(
      "validation",
      `冻结 manifest 的差异超出能力闭包范围（${mismatches.join("、")} 与当前解析不一致）；拒绝迁移，保持拒绝启动`,
      { details: { fields: mismatches.join(",") } },
    );
  }
}

interface FrozenModuleEntry {
  readonly moduleId: string;
  readonly version: unknown;
  readonly apiVersion: unknown;
  readonly configHash: unknown;
}

function moduleEntries(value: unknown): readonly FrozenModuleEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Readonly<Record<string, unknown>>;
    if (typeof record["moduleId"] !== "string") {
      return [];
    }
    return [{
      moduleId: record["moduleId"],
      version: record["version"],
      apiVersion: record["apiVersion"],
      configHash: record["configHash"],
    }];
  });
}

/** 迁移事务内的并发防御：online 别名必须仍指向读取时的源分支，漂移即拒绝，避免双迁移互相覆盖。 */
function assertAliasStillOnSourceBranch(tx: StorageTransaction, online: OnlineEntry): void {
  const alias = tx.rows("world_aliases").get({ alias: "online" });
  const currentBranchId = typeof alias?.["branch_id"] === "string" ? alias["branch_id"] : "";
  if (currentBranchId !== online.branchId) {
    throw new DomainError(
      "validation",
      `在线别名已指向分支 ${currentBranchId}，不再是迁移读取的源分支 ${online.branchId}；拒绝基于过时入口迁移`,
      { details: { aliasBranchId: currentBranchId, sourceBranchId: online.branchId } },
    );
  }
}

function putRunRow(tx: StorageTransaction, input: MigrateOnlineRunInput, runId: string, branchId: string, nowIso: string): void {
  const sourceRun = input.online.run;
  tx.rows("runs").put({
    run_id: runId,
    world_id: input.online.worldId,
    branch_id: branchId,
    mode: "live",
    status: "running",
    run_spec_json: input.runSpec,
    manifest_json: input.manifest as unknown as Json,
    manifest_hash: input.manifestHash,
    contaminated: numericCell(sourceRun["contaminated"], 0),
    evidence_complete: numericCell(sourceRun["evidence_complete"], 1),
    created_at: nowIso,
    started_at: nowIso,
    ended_at: null,
  });
}

/**
 * 把源分支置为 archived：与「重新开局把旧分支设为 archived」同一让位语义。
 * 只有分支状态位变化；run 行、manifest 与事件历史全部保留，且 archived 分支不再计入部署级激活配额。
 */
function archiveSourceBranch(tx: StorageTransaction, online: OnlineEntry): void {
  tx.rows("branches").put({ ...online.branch, status: "archived" });
}

/**
 * 读取源分支可恢复的状态：readOnlineEntry 只放行 active 与 paused，
 * 这里再校验一次，避免未知状态被当作可补偿状态参与回写。
 */
function sourceBranchStatusOf(branch: Readonly<Record<string, unknown>>): "active" | "paused" {
  const status = branch["status"];
  if (status !== "active" && status !== "paused") {
    throw new DomainError("invalid-state", `在线分支状态为 ${String(status)}，不在可迁移状态内`);
  }
  return status;
}

/**
 * 把派生分支的 Agent 激活恢复为源分支的状态：fork 的安全修正把复制出的激活置 dormant，
 * 迁移是恢复而非重开，源分支名册中 active 的身份在新分支上保持 active，
 * 否则迁移后的世界将不再调度 NPC。
 */
function restoreForkedActivations(tx: StorageTransaction, sourceBranchId: string, dstBranchId: string): void {
  tx.all(
    "UPDATE agent_activations SET status = 'active' WHERE branch_id = ? AND agent_id IN " +
      "(SELECT agent_id FROM agent_activations WHERE branch_id = ? AND status = 'active')",
    [dstBranchId, sourceBranchId],
  );
}

/**
 * 执行显式迁移：单事务内校验别名、派生 online 分支、写入新 run 行、
 * 把源分支置为 archived 并切换 online 别名。forkBranch 在同一事务内复制全部分支级表
 * （事件与状态原样延续），并暂停新分支时钟、释放未完成 trigger、把激活置为 dormant 后
 * 按源分支恢复。源 run 行与源 manifest 不做任何修改。
 */
export function migrateOnlineRun(input: MigrateOnlineRunInput): MigratedOnlineRun {
  const runId = input.host.ids("run");
  const branchId = input.host.ids("br");
  const nowIso = input.host.nowIso();
  // 源分支状态必须在迁移事务内读取：启动早期快照之后分支可能被暂停，
  // 用快照里的旧状态做补偿会把并发发生的 paused 改回 active。
  let sourceBranchStatus: "active" | "paused" | null = null;
  input.storage.transact((tx) => {
    assertAliasStillOnSourceBranch(tx, input.online);
    const currentSource = tx.rows("branches").get({ branch_id: input.online.branchId });
    if (currentSource === null) {
      throw new DomainError("invalid-state", `迁移源分支 ${input.online.branchId} 在事务内不存在`);
    }
    sourceBranchStatus = sourceBranchStatusOf(currentSource);
    input.storage.forkBranch(tx, {
      srcBranchId: input.online.branchId,
      dstBranchId: branchId,
      kind: "online",
      runId,
      profileHash: null,
    });
    putRunRow(tx, input, runId, branchId, nowIso);
    archiveSourceBranch(tx, input.online);
    restoreForkedActivations(tx, input.online.branchId, branchId);
    tx.rows("world_aliases").put({ alias: "online", branch_id: branchId, updated_at: nowIso });
  });
  if (sourceBranchStatus === null) {
    throw new DomainError("invalid-state", "迁移事务未记录源分支状态");
  }
  return { runId, branchId, sourceBranchStatus };
}

/**
 * 迁移已提交但宿主启动失败时的补偿：把 online 别名恢复指向源分支，并恢复源分支迁移前的状态。
 * 迁移把源分支置为 archived，这里只能写回迁移事务读取到的原状态（active 或 paused），
 * 不能无条件设为 active：paused 是合法的在线分支状态，改写它会放大失败影响面。
 * 迁移产生的新分支与新 run 不删除，作为孤儿记录留存供审计；源 run 行与 manifest 始终未变。
 *
 * @param sourceBranchStatus 迁移事务读取到的源分支状态；只接受 active 或 paused。
 */
export function restoreOnlineAliasToSourceBranch(
  storage: StoragePort,
  nowIso: string,
  sourceBranchId: string,
  sourceBranchStatus: "active" | "paused",
): void {
  storage.transact((tx) => {
    const sourceBranch = tx.rows("branches").get({ branch_id: sourceBranchId });
    if (sourceBranch !== null) {
      tx.rows("branches").put({ ...sourceBranch, status: sourceBranchStatus });
    }
    tx.rows("world_aliases").put({ alias: "online", branch_id: sourceBranchId, updated_at: nowIso });
  });
}

/** 迁移证据描述：源与新 run 的标识，不含 seed 与任何凭据，供启动日志使用。 */
export function migrationSummary(input: MigrateOnlineRunInput, migrated: MigratedOnlineRun): string {
  return `在线 run 迁移完成：源 run ${input.online.runId}（分支 ${input.online.branchId}）已归档且数据保留，` +
    `新 run ${migrated.runId}（分支 ${migrated.branchId}）按当前能力闭包冻结 manifest ${input.manifestHash}。`;
}
