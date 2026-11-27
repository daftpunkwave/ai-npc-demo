/**
 * 核心职责：实验执行器集成测试的共用夹具：启动测试装配宿主、登录研究员会话、按内联规格创建实验并启动 run、
 * 等待 run 到达终态，读取 run、分支、探针结果、实验汇总与控制租约的存储事实，以及追加脚本步骤的内容包副本。
 * 交互契约：使用真实测试装配（确定性模型传输）、SQLite 临时目录与控制台 HTTP 接口；不访问网络与真实模型。
 * 约束与禁忌：只读断言所需的存储行，不改写执行器写入的数据；临时目录与宿主由调用方在 afterEach 中释放。
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { startHost, type HostOptions, type RunningHost } from "@world-prism/app-server";
import { experimentCreateResponseSchema, type Json } from "@world-prism/contracts";

/** 测试登记的宿主与临时目录；afterEach 统一释放。 */
export interface ExperimentTestResources {
  readonly hosts: RunningHost[];
  readonly roots: string[];
}

/** 新建临时目录并登记。 */
export function tempRoot(resources: ExperimentTestResources, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  resources.roots.push(root);
  return root;
}

/** 启动测试装配宿主；在线世界不开局，因此不占用 Agent 配额，除非用例显式开局。 */
export async function experimentHost(
  resources: ExperimentTestResources,
  overrides: Partial<HostOptions> = {},
): Promise<RunningHost> {
  const host = await startHost({
    dataDir: tempRoot(resources, "world-prism-experiment-runner-"),
    playerToken: "experiment-player",
    consoleToken: "experiment-console",
    assemblyRef: "local-slg-test-v1",
    rosterRef: "core-3",
    ...overrides,
  });
  resources.hosts.push(host);
  return host;
}

/** 登录控制台并返回研究员请求头。 */
export async function researcherHeaders(host: RunningHost): Promise<Record<string, string>> {
  const response = await host.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { token: "experiment-console" } });
  expect(response.statusCode).toBe(200);
  const { sessionToken } = response.json() as { readonly sessionToken: string };
  return { Authorization: `Bearer ${sessionToken}`, "X-Active-Role": "researcher" };
}

/** 测试装配下的实验规格；默认用确定性决策，变体、分支与公共补丁由用例指定。 */
export function experimentSpec(overrides: {
  readonly experimentId: string;
  readonly variants?: readonly string[];
  readonly scriptBranches?: readonly string[];
  readonly commonPatchRefs?: readonly string[];
  readonly scriptRef?: string;
}): Record<string, Json> {
  return {
    schemaVersion: 1,
    experimentId: overrides.experimentId,
    base: {
      moduleAssemblyRef: "local-slg-test-v1",
      worldPackRef: "earth-2964-v1",
      scenarioRef: "watergate-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
      seed: overrides.experimentId,
      player: { principalId: "player-1", factionId: "human-neutral" },
      mode: "closed-loop",
      initialState: { kind: "cold-start" },
      clock: { kind: "controlled" },
      budget: { maxTokens: null, maxCost: null },
      failurePolicy: "strict",
    },
    scriptRef: overrides.scriptRef ?? "s-promise",
    scriptBranches: [...(overrides.scriptBranches ?? ["keep"])],
    commonPatchRefs: [...(overrides.commonPatchRefs ?? ["decision-deterministic"])],
    variants: [...(overrides.variants ?? ["memory-m1-structured-ledger"])],
    repetitions: 1,
    runOrder: "sequential",
  };
}

/** 按内联规格创建实验，断言全部 run 预检通过并返回 run ID。 */
export async function createExperimentRuns(
  host: RunningHost,
  headers: Record<string, string>,
  spec: Record<string, Json>,
): Promise<readonly string[]> {
  const response = await host.app.inject({
    method: "POST", url: "/api/v1/console/experiments", headers, payload: { experimentSpec: spec },
  });
  expect(response.statusCode, response.body).toBe(200);
  const created = experimentCreateResponseSchema.parse(response.json());
  expect(created.failedRunCount).toBe(0);
  return created.runIds;
}

/** 启动或恢复 run。 */
export async function startRun(host: RunningHost, headers: Record<string, string>, runId: string, operationId: string): Promise<void> {
  const response = await host.app.inject({
    method: "POST", url: `/api/v1/console/runs/${runId}/start`, headers, payload: { operationId },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** 停止 run。 */
export async function stopRun(host: RunningHost, headers: Record<string, string>, runId: string, operationId: string): Promise<void> {
  const response = await host.app.inject({
    method: "POST", url: `/api/v1/console/runs/${runId}/stop`, headers, payload: { operationId },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** 读取 run 行。 */
export function runRow(host: RunningHost, runId: string): Readonly<Record<string, unknown>> {
  const row = host.storage.transact((tx) => tx.rows("runs").get({ run_id: runId }));
  if (row === null) throw new Error(`run ${runId} 不存在`);
  return row;
}

/** 等待 run 离开 running 并返回终态。 */
export async function waitForRunStatus(
  host: RunningHost,
  runId: string,
  expected: readonly string[],
  timeout = 60_000,
): Promise<string> {
  return vi.waitFor(() => {
    const status = String(runRow(host, runId)["status"]);
    expect(expected).toContain(status);
    return status;
  }, { timeout, interval: 50 });
}

/** run 归属的实验分支。 */
export function branchOf(host: RunningHost, runId: string): string {
  return String(runRow(host, runId)["branch_id"]);
}

/** 某分支的领域事件类型序列。 */
export function eventTypes(host: RunningHost, branchId: string): readonly string[] {
  return host.storage.transact((tx) =>
    tx.all("SELECT type FROM domain_events WHERE branch_id = ? ORDER BY world_seq", [branchId]).map((row) => String(row["type"])));
}

/** 某分支的时钟 tick。 */
export function worldTickOf(host: RunningHost, branchId: string): number {
  return Number(host.storage.transact((tx) => tx.branch(branchId).table("clock").get({})?.["world_tick"]));
}

/** run 的探针结果行，按写入时间排序。 */
export function probeResults(host: RunningHost, runId: string): readonly Readonly<Record<string, unknown>>[] {
  return host.storage.transact((tx) => tx.rows("probe_results").list({ run_id: runId }, { orderBy: [{ column: "created_at" }] }));
}

/** run 的实验汇总行，按指标名排序。 */
export function experimentResults(host: RunningHost, runId: string): readonly Readonly<Record<string, unknown>>[] {
  return host.storage.transact((tx) => tx.rows("experiment_results").list({ run_id: runId }, { orderBy: [{ column: "metric" }] }));
}

/** 从实验分支派生的沙盒分支行。 */
export function sandboxesOf(host: RunningHost, branchId: string): readonly Readonly<Record<string, unknown>>[] {
  return host.storage.transact((tx) => tx.rows("branches").list({ parent_branch_id: branchId, kind: "sandbox" }));
}

/** 执行器写在实验分支上的审计事件类型与载荷。 */
export function experimentAudit(host: RunningHost, branchId: string): readonly { readonly type: string; readonly payload: Json }[] {
  return host.storage.transact((tx) => tx.all(
    "SELECT type, payload_json FROM lifecycle_events WHERE branch_id = ? AND type LIKE 'Experiment%' ORDER BY seq",
    [branchId],
  ).map((row) => ({ type: String(row["type"]), payload: JSON.parse(String(row["payload_json"])) as Json })));
}

/** 实验分支上的控制变更审计：主体、所属 run 与载荷，按写入顺序。 */
export function controllerChanges(
  host: RunningHost,
  branchId: string,
): readonly { readonly subjectId: unknown; readonly runId: unknown; readonly payload: Record<string, Json> }[] {
  return host.storage.transact((tx) => tx.all(
    "SELECT subject_id, run_id, payload_json FROM lifecycle_events WHERE branch_id = ? AND type = 'ControllerChanged' ORDER BY seq",
    [branchId],
  ).map((row) => ({ subjectId: row["subject_id"], runId: row["run_id"], payload: JSON.parse(String(row["payload_json"])) as Record<string, Json> })));
}

/** 某分支上某个身份的控制租约：种类、控制者与代次。 */
export function controllerLease(host: RunningHost, branchId: string, agentId: string): readonly unknown[] {
  return host.storage.transact((tx) => {
    const row = tx.branch(branchId).table("controller_leases").get({ agent_id: agentId });
    return [row?.["controller_kind"], row?.["controller_principal_id"], row?.["controller_epoch"]];
  });
}

/**
 * 复制内容包，在 s-secret 原有的玩家步骤之后追加步骤（每行一条 YAML 流式映射），返回新内容根目录。
 * 用于以 Agent 身份声明脚本步骤：内容校验只要求 `as` 是内容包登记的主体，名册与权限由执行器与规则裁决。
 */
export function secretScriptWithSteps(resources: ExperimentTestResources, extraSteps: readonly string[]): string {
  const root = join(tempRoot(resources, "world-prism-experiment-content-"), "content");
  cpSync("content", root, { recursive: true });
  const scriptFile = join(root, "world-packs", "earth-2964-v1", "scripts", "s-secret.yaml");
  const original = readFileSync(scriptFile, "utf8").replaceAll("\r\n", "\n");
  const rewritten = original.replace("\ncheckpoints:", `\n${extraSteps.map((step) => `  - ${step}\n`).join("")}checkpoints:`);
  if (rewritten === original) throw new Error("s-secret 的脚本格式已变化，无法追加步骤");
  writeFileSync(scriptFile, rewritten, "utf8");
  return root;
}

/** 某分支上仍为 active 的身份。 */
export function activeAgentsOn(host: RunningHost, branchId: string): readonly string[] {
  return host.storage.transact((tx) => tx.branch(branchId).table("agent_activations").list({ status: "active" })
    .map((row) => String(row["agent_id"])));
}

/** 部署范围内活动分支上的活动身份数；与激活事务的配额统计口径一致。 */
export function activeIdentityCount(host: RunningHost): number {
  return Number(host.storage.transact((tx) => tx.get(
    "SELECT COUNT(*) AS count FROM agent_activations a JOIN branches b ON a.branch_id = b.branch_id WHERE a.status = 'active' AND b.status IN ('active', 'paused')",
  )?.["count"]));
}
