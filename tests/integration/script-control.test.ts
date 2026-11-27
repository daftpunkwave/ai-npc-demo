/**
 * 核心职责：验证实验执行器的脚本控制：只能在实验分支上从 Agent 自己控制的身份取得，取得与交还各递增一次控制代次并写审计；
 * 脚本代发的命令按被控 Agent 的权限由规则裁决，窗口内外的 Agent turn 与过期的脚本代次都被 fencing 拒绝，
 * 真人或玩家会话即使拿到脚本代次也不能借用。
 * 交互契约：使用真实 SQLite、内容包、游戏模块与 authority 命令网关；分支种类与控制租约由支架登记。
 * 约束与禁忌：禁止用测试内自建处理器替代真实注册；断言读真实回执、领域事件、租约与生命周期审计。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireScriptControl,
  releaseLeftoverScriptControl,
  releaseScriptControl,
  type ScriptControlRequest,
} from "@world-prism/agent-runtime";
import { createSystemAuth } from "@world-prism/authority";
import type { AuthContext, Json } from "@world-prism/contracts";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  operatorAuth,
  playerAuth,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

const active: GameHarness[] = [];
const runId = "run-00000scrip1";
const alliance = "human-earth-alliance";
const independent = "human-independent";

afterEach(async () => {
  await disposeTrackedGameHarnesses(active);
});

function setBranchKind(harness: GameHarness, kind: "online" | "experiment" | "sandbox"): void {
  harness.storage.transact((tx) => {
    const branch = tx.rows("branches").get({ branch_id: harness.branchId });
    if (branch === null) throw new Error("缺少测试分支行");
    tx.rows("branches").put({ ...branch, kind });
  });
}

function seedLease(harness: GameHarness, agentId: string, kind: "agent" | "human" | "script", epoch: number, principal: string | null = null): void {
  harness.storage.transact((tx) => {
    tx.branch(harness.branchId).table("controller_leases").put({
      agent_id: agentId, controller_kind: kind, controller_principal_id: principal, controller_epoch: epoch, lease_expires_at: null,
    });
  });
}

function lease(harness: GameHarness, agentId: string): readonly unknown[] {
  return harness.storage.transact((tx) => {
    const row = tx.branch(harness.branchId).table("controller_leases").get({ agent_id: agentId });
    return [row?.["controller_kind"], row?.["controller_principal_id"], row?.["controller_epoch"]];
  });
}

function request(harness: GameHarness, agentId: string, context: Readonly<Record<string, Json>> = {}): ScriptControlRequest {
  return { branchId: harness.branchId, agentId, runId, nowIso: harness.host.nowIso(), context };
}

function acquire(harness: GameHarness, agentId: string, context: Readonly<Record<string, Json>> = {}) {
  return harness.storage.transact((tx) => acquireScriptControl(tx, request(harness, agentId, context)));
}

function release(harness: GameHarness, agentId: string, context: Readonly<Record<string, Json>> = {}) {
  return harness.storage.transact((tx) => releaseScriptControl(tx, request(harness, agentId, context)));
}

/** 实验执行器在脚本控制下代某个 Agent 提交时使用的认证上下文。 */
function scriptedAuth(harness: GameHarness, agentId: string, controllerEpoch: number): AuthContext {
  return {
    principalId: agentId, kind: "system", roles: [], worldId: harness.worldId, branchId: harness.branchId,
    actingAsAgentId: agentId, controllerEpoch, turnId: null, turnLeaseEpoch: null,
  };
}

function controllerChanges(harness: GameHarness): readonly { readonly runId: unknown; readonly subjectId: unknown; readonly payload: Json }[] {
  return harness.storage.transact((tx) => tx.all(
    "SELECT run_id, subject_id, payload_json FROM lifecycle_events WHERE branch_id = ? AND type = 'ControllerChanged' ORDER BY seq",
    [harness.branchId],
  ).map((row) => ({ runId: row["run_id"], subjectId: row["subject_id"], payload: JSON.parse(String(row["payload_json"])) as Json })));
}

function eventCount(harness: GameHarness): number {
  return harness.storage.transact((tx) => tx.branch(harness.branchId).table("domain_events").count());
}

/** 某类型最近一条领域事件的记录主体与载荷。 */
function lastEvent(harness: GameHarness, type: string): { readonly principalId: unknown; readonly payload: Record<string, Json> } {
  return harness.storage.transact((tx) => {
    const row = tx.get(
      "SELECT principal_id, payload_json FROM domain_events WHERE branch_id = ? AND type = ? ORDER BY world_seq DESC LIMIT 1",
      [harness.branchId, type],
    );
    return { principalId: row?.["principal_id"], payload: JSON.parse(String(row?.["payload_json"])) as Record<string, Json> };
  });
}

const shareLedger = { evidenceId: "ev-water-ledger", audience: ["player-1"] };
const restrictPass = { key: "road.status:r-gh-ps", value: "restricted" };

/** 已开局的实验分支，名册中两名党魁由 Agent 自己控制（代次 1）。 */
async function startedExperiment(): Promise<GameHarness> {
  const harness = await createTrackedGameHarness(active);
  setBranchKind(harness, "experiment");
  expect(startNeutralCampaign(harness).commandStatus).toBe("accepted");
  seedLease(harness, alliance, "agent", 1);
  seedLease(harness, independent, "agent", 1);
  return harness;
}

describe("实验执行器的脚本控制", () => {
  it("只能在活动的实验分支上从 Agent 自己控制的身份取得；取得与交还各递增一次代次并写审计", async () => {
    const harness = await createTrackedGameHarness(active);
    seedLease(harness, alliance, "agent", 1);
    seedLease(harness, independent, "human", 4, "operator-1");
    // 在线与沙盒分支一律拒绝，租约不变。
    for (const kind of ["online", "sandbox"] as const) {
      setBranchKind(harness, kind);
      expect(() => acquire(harness, alliance)).toThrow(expect.objectContaining({ code: "forbidden" }));
      expect(lease(harness, alliance)).toEqual(["agent", null, 1]);
    }
    setBranchKind(harness, "experiment");
    // 真人接管中的身份不能被脚本抢占；没有租约的身份没有可取得的控制。
    expect(() => acquire(harness, independent)).toThrow(expect.objectContaining({ code: "invalid-state" }));
    expect(() => acquire(harness, "human-alien-accord")).toThrow(expect.objectContaining({ code: "invalid-state" }));

    expect(acquire(harness, alliance, { declarationIndex: 3 })).toEqual({ agentId: alliance, fromKind: "agent", toKind: "script", fromEpoch: 1, toEpoch: 2 });
    expect(lease(harness, alliance)).toEqual(["script", runId, 2]);
    expect(() => acquire(harness, alliance)).toThrow(expect.objectContaining({ code: "invalid-state" }));
    // 只有持有窗口的 run 能交还。
    expect(() => harness.storage.transact((tx) => releaseScriptControl(tx, { ...request(harness, alliance), runId: "run-00000other" })))
      .toThrow(expect.objectContaining({ code: "invalid-state" }));
    expect(release(harness, alliance, { declarationIndex: 3 })).toEqual({ agentId: alliance, fromKind: "script", toKind: "agent", fromEpoch: 2, toEpoch: 3 });
    expect(lease(harness, alliance)).toEqual(["agent", null, 3]);
    expect(() => release(harness, alliance)).toThrow(expect.objectContaining({ code: "invalid-state" }));

    expect(controllerChanges(harness)).toEqual([
      { runId, subjectId: alliance, payload: { fromKind: "agent", toKind: "script", fromEpoch: 1, toEpoch: 2, controllerPrincipalId: runId, context: { declarationIndex: 3 } } },
      { runId, subjectId: alliance, payload: { fromKind: "script", toKind: "agent", fromEpoch: 2, toEpoch: 3, controllerPrincipalId: runId, context: { declarationIndex: 3 } } },
    ]);
  });

  it("执行被打断后遗留的脚本控制按取得时的上下文交还，并标记为恢复", async () => {
    const harness = await startedExperiment();
    acquire(harness, independent, { declarationIndex: 1, atTick: 4, commandId: "cmd-0000000000a1" });
    expect(harness.storage.transact((tx) => releaseLeftoverScriptControl(tx, { branchId: harness.branchId, runId: "run-00000other", nowIso: harness.host.nowIso() })))
      .toEqual([]);
    expect(harness.storage.transact((tx) => releaseLeftoverScriptControl(tx, { branchId: harness.branchId, runId, nowIso: harness.host.nowIso() })))
      .toEqual([{ agentId: independent, fromKind: "script", toKind: "agent", fromEpoch: 2, toEpoch: 3 }]);
    expect(lease(harness, independent)).toEqual(["agent", null, 3]);
    expect(controllerChanges(harness).at(-1)?.payload).toMatchObject({
      fromKind: "script", toKind: "agent", fromEpoch: 2, toEpoch: 3,
      context: { declarationIndex: 1, atTick: 4, commandId: "cmd-0000000000a1", recovered: true },
    });
    // 没有遗留时不做任何写入。
    const before = controllerChanges(harness).length;
    expect(harness.storage.transact((tx) => releaseLeftoverScriptControl(tx, { branchId: harness.branchId, runId, nowIso: harness.host.nowIso() }))).toEqual([]);
    expect(controllerChanges(harness)).toHaveLength(before);
  });

  it("脚本代发的命令按被控 Agent 的权限由规则裁决，交还后旧脚本代次被拒绝，重放取回原回执", async () => {
    const harness = await startedExperiment();
    const { toEpoch } = acquire(harness, alliance);
    const auth = scriptedAuth(harness, alliance, toEpoch);

    // 联盟持有水闸分水账：分享被受理，事件与回执都记在该 Agent 名下。
    const shared = harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000b1"));
    expect(shared).toMatchObject({ commandStatus: "accepted" });
    expect(lastEvent(harness, "InformationShared")).toMatchObject({ principalId: alliance, payload: { fromId: alliance, evidenceId: "ev-water-ledger" } });
    // 没有持有的证据、只属于玩家或系统的命令、不受该 Agent 控制的道路，都按该 Agent 的权限拒绝。
    const rejections = [
      harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", { evidenceId: "ev-exchange-draft", audience: ["player-1"] }, "cmd-0000000000b2")),
      harness.authority.commands.execute(auth, gameCommandEnvelope("dialogue.say", { targetAgentId: independent, text: "你好。" }, "cmd-0000000000b3")),
      harness.authority.commands.execute(auth, gameCommandEnvelope("knowledge.seed", { evidenceId: "ev-flood-log", principalId: alliance }, "cmd-0000000000b4")),
      harness.authority.commands.execute(auth, gameCommandEnvelope("policy.set", restrictPass, "cmd-0000000000b5")),
    ];
    expect(rejections.map(({ commandStatus, reasonCode }) => [commandStatus, reasonCode])).toEqual([
      ["rejected", "evidence-not-held"], ["rejected", "no-authority"], ["rejected", "no-authority"], ["rejected", "no-authority"],
    ]);
    // 同一道路由其控制方 Agent 在脚本控制下设置时受理：裁决看的是被控 Agent，而不是系统身份。
    const pass = acquire(harness, independent);
    expect(harness.authority.commands.execute(scriptedAuth(harness, independent, pass.toEpoch), gameCommandEnvelope("policy.set", restrictPass, "cmd-0000000000b6")))
      .toMatchObject({ commandStatus: "accepted" });
    expect(lastEvent(harness, "PolicyChanged")).toMatchObject({ principalId: independent, payload: { byId: independent } });

    release(harness, alliance);
    const events = eventCount(harness);
    const stale = harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000b7"));
    expect(stale).toMatchObject({ commandStatus: "rejected", reasonCode: "stale-controller" });
    // 恢复执行时以原命令 ID 重放：幂等检查先于 fencing，取回原受理回执，不产生新事件。
    expect(harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000b1")))
      .toEqual(shared);
    expect(eventCount(harness)).toBe(events);
  });

  it("取得与交还都隔离该 Agent 在途 turn 的旧代次；交还后新 turn 以新代次提交", async () => {
    const harness = await startedExperiment();
    const turnAuth = (turnId: string, controllerEpoch: number): AuthContext => ({
      principalId: alliance, kind: "agent", roles: ["agent"], worldId: harness.worldId, branchId: harness.branchId,
      actingAsAgentId: null, controllerEpoch, turnId, turnLeaseEpoch: 1,
    });
    const seedTurn = (turnId: string, controllerEpoch: number): void => {
      harness.storage.transact((tx) => tx.rows("turn_runs").put({
        turn_id: turnId, run_id: runId, branch_id: harness.branchId, agent_id: alliance, agent_turn_index: 1, status: "executing",
        trigger_ids_json: [], input_frontier_json: null, memory_revision: null, profile_hash: "test-profile",
        controller_epoch: controllerEpoch, turn_lease_epoch: 1, lease_expires_at: "2099-01-01T00:00:00.000Z",
        terminal_reason: null, effective_json: null, created_at: harness.host.nowIso(), created_tick: 0, started_at: null, ended_at: null,
      }));
    };
    seedTurn("turn-0000000000c1", 1);
    const share = (auth: AuthContext, commandId: string) =>
      harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", shareLedger, commandId));
    expect(share(turnAuth("turn-0000000000c1", 1), "cmd-0000000000c1")).toMatchObject({ commandStatus: "accepted" });

    acquire(harness, alliance);
    expect(share(turnAuth("turn-0000000000c1", 1), "cmd-0000000000c2")).toMatchObject({ commandStatus: "rejected", reasonCode: "stale-controller" });
    release(harness, alliance);
    // 交还后的代次是 3：窗口之前领到代次 1 的 turn 仍是过期控制，不会因为控制回到 agent 而复活。
    expect(share(turnAuth("turn-0000000000c1", 1), "cmd-0000000000c3")).toMatchObject({ commandStatus: "rejected", reasonCode: "stale-controller" });
    seedTurn("turn-0000000000c2", 3);
    expect(share(turnAuth("turn-0000000000c2", 3), "cmd-0000000000c4")).toMatchObject({ commandStatus: "accepted" });
  });

  it("执行器以外的主体不能借用脚本控制，脚本代发也不能离开实验分支", async () => {
    const harness = await startedExperiment();
    const { toEpoch } = acquire(harness, alliance);
    // 真人席位与玩家会话即使携带脚本代次也只能凭真人控制代发，种类不符按过期控制拒绝。
    const borrowed = [
      { ...operatorAuth(harness), actingAsAgentId: alliance, controllerEpoch: toEpoch },
      { ...playerAuth(harness), actingAsAgentId: alliance, controllerEpoch: toEpoch },
    ].map((auth, index) => harness.authority.commands.execute(auth, gameCommandEnvelope("information.share", shareLedger, `cmd-0000000000d${index}`)));
    expect(borrowed.map(({ reasonCode }) => reasonCode)).toEqual(["stale-controller", "stale-controller"]);
    // 不带代次、代次不符的系统代发同样拒绝。
    expect(harness.authority.commands.execute({ ...scriptedAuth(harness, alliance, toEpoch), controllerEpoch: null }, gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000d2")))
      .toMatchObject({ reasonCode: "stale-controller" });
    expect(harness.authority.commands.execute(scriptedAuth(harness, alliance, toEpoch + 1), gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000d3")))
      .toMatchObject({ reasonCode: "stale-controller" });

    // 在线与沙盒分支上即便出现脚本租约（例如被直接写入），网关也不承认。
    for (const kind of ["online", "sandbox"] as const) {
      setBranchKind(harness, kind);
      expect(harness.authority.commands.execute(scriptedAuth(harness, alliance, toEpoch), gameCommandEnvelope("information.share", shareLedger, `cmd-0000000000e${kind.length}`)))
        .toMatchObject({ commandStatus: "rejected", reasonCode: "stale-controller" });
    }
    // 系统世界身份本身不代任何 Agent，仍不能发行 Agent 专属命令。
    setBranchKind(harness, "experiment");
    expect(harness.authority.commands.execute(createSystemAuth(harness.worldId, harness.branchId), gameCommandEnvelope("information.share", shareLedger, "cmd-0000000000d4")))
      .toMatchObject({ commandStatus: "rejected", reasonCode: "no-authority" });
  });
});
