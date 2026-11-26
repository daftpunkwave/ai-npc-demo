/**
 * 协议与任务集成测试的公共步骤：命令网关调用、协议提出与接受、任务派遣、tick 推进及条款断言。
 * 依赖 game-support 提供的真实 SQLite 环境与 authority；只组合公开命令与已提交事实，不直接改写协议、任务或世界聚合。
 * 禁止在这里放宽命令校验、吞掉被拒回执或用默认参数替代调用方的条款。
 */
import { afterEach, expect } from "vitest";
import type { AuthContext, CommandReceipt, CommandType, Json, Term } from "@world-prism/contracts";
import {
  createTrackedGameHarness,
  disposeTrackedGameHarnesses,
  gameCommandEnvelope,
  playerAuth,
  readGameAggregate,
  readGameEvents,
  strategicAuth,
  setGameClock,
  startNeutralCampaign,
  type GameHarness,
} from "./game-support";

export {
  createMemoryTx,
  operatorAuth,
  playerAuth,
  readGameAggregate,
  readGameEventAudience,
  readGameEvents,
  setGameClock,
  strategicAuth,
  type GameHarness,
} from "./game-support";

/** 命令网关回执，供测试自行断言 reasonCode 等字段。 */
export type Receipt = CommandReceipt;

/** 玩家从灰港向果园运输 5 点供给的载荷；用于部分交付与委托回补等用例。 */
export const PARTIAL_SUPPLY_TRANSPORT: Json = {
  taskType: "transport",
  teamId: "team-commons",
  params: {
    fromStockpileId: "sp-commons",
    toStockpileId: "sp-earth",
    cargo: { supply: 5, energy: 0, medical: 0 },
  },
};

/**
 * 注册一个 afterEach 释放的 harness 工厂；返回创建并完成开局的异步函数。
 * 各测试文件只需持有一个工厂，避免重复复制 active 列表与释放样板。
 */
export function useStartedGameHarnesses(): (
  options?: Parameters<typeof createTrackedGameHarness>[1],
) => Promise<GameHarness> {
  const active: GameHarness[] = [];
  afterEach(async () => {
    await disposeTrackedGameHarnesses(active);
  });
  return async (options = {}) => createStartedCampaignHarness(active, options);
}

/** 以指定主体走命令网关提交命令。 */
export function executeCommand(value: GameHarness, auth: AuthContext, type: CommandType, payload: Json): Receipt {
  return value.authority.commands.execute(auth, gameCommandEnvelope(type, payload, value.host.ids("cmd")));
}

/** 创建独立 harness 并完成人类中立阵营开局；开局被拒时立即失败。 */
export async function createStartedCampaignHarness(
  active: GameHarness[],
  options: Parameters<typeof createTrackedGameHarness>[1] = {},
): Promise<GameHarness> {
  const value = await createTrackedGameHarness(active, options);
  expect(startNeutralCampaign(value).commandStatus).toBe("accepted");
  return value;
}

/** 以指定主体提出协议并返回回执，供调用方断言接受或拒绝。 */
export function proposeAgreementCommand(
  value: GameHarness,
  auth: AuthContext,
  parties: readonly string[],
  terms: readonly Term[],
  options: { readonly expiresInTicks?: number } = {},
): Receipt {
  const payload: Json =
    options.expiresInTicks === undefined
      ? { parties: [...parties], terms: [...terms] }
      : { parties: [...parties], terms: [...terms], expiresInTicks: options.expiresInTicks };
  return executeCommand(value, auth, "agreement.propose", payload);
}

/** 以指定主体提出协议，断言被接受并返回协议 ID。 */
export function proposeAgreement(
  value: GameHarness,
  auth: AuthContext,
  parties: readonly string[],
  terms: readonly Term[],
  options: { readonly expiresInTicks?: number } = {},
): string {
  const command = proposeAgreementCommand(value, auth, parties, terms, options);
  expect(command.commandStatus).toBe("accepted");
  return (command.result as { readonly agreementId: string }).agreementId;
}

/** 回复协议；返回回执，由调用方断言接受、拒绝或还价结果。 */
export function respondAgreement(
  value: GameHarness,
  auth: AuthContext,
  agreementId: string,
  response: "accept" | "decline" | "counter",
  counterTerms?: readonly Term[],
): Receipt {
  const payload: Json =
    counterTerms === undefined
      ? { agreementId, response }
      : { agreementId, response, counterTerms: [...counterTerms] };
  return executeCommand(value, auth, "agreement.respond", payload);
}

/** 接受协议并断言成功。 */
export function acceptAgreement(value: GameHarness, auth: AuthContext, agreementId: string): void {
  expect(respondAgreement(value, auth, agreementId, "accept").commandStatus).toBe("accepted");
}

/** 以指定提出者与接受者完成提出+接受，返回协议 ID。 */
export function proposeAndAccept(
  value: GameHarness,
  proposer: AuthContext,
  responder: AuthContext,
  parties: readonly string[],
  terms: readonly Term[],
  options: { readonly expiresInTicks?: number } = {},
): string {
  const agreementId = proposeAgreement(value, proposer, parties, terms, options);
  acceptAgreement(value, responder, agreementId);
  return agreementId;
}

/** 以玩家身份提出协议、指定战略 Agent 接受；返回协议 ID。 */
export function proposeAsPlayer(
  value: GameHarness,
  responderAgentId: string,
  parties: readonly string[],
  terms: readonly Term[],
  options: { readonly expiresInTicks?: number } = {},
): string {
  return proposeAndAccept(value, playerAuth(value), strategicAuth(value, responderAgentId), parties, terms, options);
}

/** 派遣任务，断言被接受并返回任务 ID。 */
export function dispatchTask(value: GameHarness, auth: AuthContext, payload: Json): string {
  const command = executeCommand(value, auth, "task.dispatch", payload);
  expect(command.commandStatus).toBe("accepted");
  return (command.result as { readonly taskId: string }).taskId;
}

/** 回复任务邀请；返回回执，由调用方断言接受或拒绝。 */
export function respondTask(
  value: GameHarness,
  agentId: string,
  taskId: string,
  response: "accept" | "decline",
): Receipt {
  return executeCommand(value, strategicAuth(value, agentId), "task.respond", { taskId, response });
}

/** 接受任务邀请并断言成功。 */
export function acceptTaskInvitation(value: GameHarness, agentId: string, taskId: string): void {
  expect(respondTask(value, agentId, taskId, "accept").commandStatus).toBe("accepted");
}

/** 取消任务；返回回执，由调用方断言接受或拒绝。 */
export function cancelTask(value: GameHarness, auth: AuthContext, taskId: string): Receipt {
  return executeCommand(value, auth, "task.cancel", { taskId });
}

/** 把时钟推进到指定 tick 并执行到期 job；不代跑消费者。 */
export function advanceTo(value: GameHarness, tick: number): void {
  setGameClock(value, { worldTick: tick, mode: "running" });
  value.authority.jobs.runDue(value.branchId, tick);
}

/** 执行到期 job 后运行消费者，按已提交事实更新协议与任务。 */
export function advanceToWithConsumers(value: GameHarness, tick: number): void {
  advanceTo(value, tick);
  runConsumers(value);
}

/** 逐个 tick 推进；consumers 为 true 时每个 tick 都运行消费者。 */
export function advanceTicks(
  value: GameHarness,
  fromTick: number,
  toTick: number,
  options: { readonly consumers?: boolean } = {},
): void {
  for (let tick = fromTick; tick <= toTick; tick += 1) {
    if (options.consumers === true) {
      advanceToWithConsumers(value, tick);
    } else {
      advanceTo(value, tick);
    }
  }
}

/** 运行一次消费者，处理已提交事件。 */
export function runConsumers(value: GameHarness): void {
  value.authority.consumers.run(value.branchId);
}

/** 协议聚合的只读视图；缺失字段由具体的条款断言补齐。 */
export interface AgreementView {
  readonly status: string;
  readonly fulfilledTerms: readonly number[];
  readonly breachedTerms: readonly number[];
  readonly progress: readonly number[];
}

/** 读取协议聚合；不存在时立即失败。 */
export function agreementView(value: GameHarness, agreementId: string): AgreementView {
  const state = readGameAggregate(value, "agreement", agreementId);
  if (state === null) {
    throw new Error(`协议 ${agreementId} 不存在`);
  }
  return state as unknown as AgreementView;
}

/** 任务聚合的只读视图；用于断言完成状态、完成 tick 与名义完成时间。 */
export interface TaskView {
  readonly status: string;
  readonly completedAtTick: number | null;
  readonly nominalCompletionTick: number;
  readonly departTick: number;
}

/** 读取任务聚合；不存在时立即失败。 */
export function taskView(value: GameHarness, taskId: string): TaskView {
  const state = readGameAggregate(value, "task", taskId);
  if (state === null) {
    throw new Error(`任务 ${taskId} 不存在`);
  }
  return state as unknown as TaskView;
}

/** 协议状态的部分断言，语义与逐字段 toMatchObject 相同。 */
export interface AgreementExpectation {
  readonly status?: string;
  readonly fulfilledTerms?: readonly number[];
  readonly breachedTerms?: readonly number[];
  readonly progress?: readonly number[];
}

/** 读取协议聚合并按期望字段断言；缺失聚合直接失败。 */
export function expectAgreement(
  value: GameHarness,
  agreementId: string,
  expected: AgreementExpectation,
): void {
  expect(agreementView(value, agreementId)).toMatchObject(expected);
}

/** 条款事件公共字段；不同条款另有各自的证据字段。 */
export interface TermEventPayload {
  readonly agreementId: string;
  readonly termIndex: number;
  readonly obligorId: string;
}

/** 指定事件类型的全部 payload，按提交顺序返回。 */
export function eventPayloads<T>(value: GameHarness, type: string): readonly T[] {
  return readGameEvents(value)
    .filter((event) => event.type === type)
    .map((event) => event.payload as unknown as T);
}

/** 指定事件类型的全部事件，按提交顺序返回。 */
export function gameEventsOf(value: GameHarness, type: string): ReturnType<typeof readGameEvents> {
  return readGameEvents(value).filter((event) => event.type === type);
}

/** 分支事件类型序列，用于断言事件是否存在及顺序。 */
export function gameEventTypes(value: GameHarness): readonly string[] {
  return readGameEvents(value).map((event) => event.type);
}

/** 当前分支的协议聚合数量，用于断言拒绝后没有业务写入。 */
export function agreementCount(value: GameHarness): number {
  return value.storage.transact((tx) =>
    tx.branch(value.branchId).table("aggregate_state").count({ aggregate_type: "agreement" }),
  );
}

/** 分支 job 的 kind 与幂等键，用于断言期限/违约检查是否调度。 */
export interface JobRow {
  readonly kind: string;
  readonly idempotencyKey: string;
}

/** 读取分支全部 job 的 kind 与幂等键，不解读执行状态。 */
export function jobRows(value: GameHarness): readonly JobRow[] {
  return value.storage.transact((tx) =>
    tx
      .branch(value.branchId)
      .table("jobs")
      .list({})
      .map((row) => ({
        kind: String(row["kind"]),
        idempotencyKey: String(row["idempotency_key"]),
      })),
  );
}

/** 条款履约断言的附加选项。 */
export interface FulfilledTermExpectation {
  /** 整份协议状态；持续义务在义务期内为 active，默认 fulfilled。 */
  readonly agreementStatus?: "fulfilled" | "active";
  /** 分支内 AgreementTermFulfilled 事件总数，默认 1。 */
  readonly termFulfilledEvents?: number;
  /** 分支内 AgreementFulfilled 事件总数，默认 1；生效期尚未收尾时为 0。 */
  readonly agreementFulfilledEvents?: number;
  /** 条款事件应携带的证据事件 ID；不传则不断言该字段。 */
  readonly evidenceEventIds?: readonly string[];
}

/** 条款履约：协议状态、条款事件 payload、整份协议收尾事件与无违约事实一起断言。 */
export function expectTermFulfilled(
  value: GameHarness,
  expectation: {
    readonly agreementId: string;
    readonly termIndex: number;
    readonly obligorId: string;
  } & FulfilledTermExpectation,
): void {
  expectAgreement(value, expectation.agreementId, {
    status: expectation.agreementStatus ?? "fulfilled",
    fulfilledTerms: [expectation.termIndex],
    breachedTerms: [],
  });
  const expectedPayload = {
    agreementId: expectation.agreementId,
    termIndex: expectation.termIndex,
    obligorId: expectation.obligorId,
    ...(expectation.evidenceEventIds === undefined ? {} : { evidenceEventIds: [...expectation.evidenceEventIds] }),
  };
  const fulfilled = eventPayloads<TermEventPayload>(value, "AgreementTermFulfilled");
  expect(fulfilled).toHaveLength(expectation.termFulfilledEvents ?? 1);
  expect(
    fulfilled.filter(
      (payload) =>
        payload.agreementId === expectation.agreementId && payload.termIndex === expectation.termIndex,
    ),
  ).toEqual([expect.objectContaining(expectedPayload)]);
  expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(
    expectation.agreementFulfilledEvents ?? 1,
  );
  expect(eventPayloads(value, "AgreementBreached")).toHaveLength(0);
}

/** 条款违约断言的附加选项。 */
export interface BreachedTermExpectation {
  /** 违约前已记的履约条款下标，默认没有。 */
  readonly fulfilledTerms?: readonly number[];
  /** 违约时保留的进度，默认不断言。 */
  readonly progress?: readonly number[];
  /** 分支内 AgreementBreached 事件总数，默认 1。 */
  readonly breachEvents?: number;
}

/** 条款违约：协议状态、违约事件 payload 与未履约收尾一起断言。 */
export function expectTermBreached(
  value: GameHarness,
  agreementId: string,
  expectation: {
    readonly termIndex: number;
    readonly obligorId: string;
  } & BreachedTermExpectation,
): void {
  expectAgreement(value, agreementId, {
    status: "breached",
    fulfilledTerms: expectation.fulfilledTerms ?? [],
    breachedTerms: [expectation.termIndex],
    ...(expectation.progress === undefined ? {} : { progress: expectation.progress }),
  });
  const breaches = eventPayloads<TermEventPayload>(value, "AgreementBreached");
  expect(breaches).toHaveLength(expectation.breachEvents ?? 1);
  expect(
    breaches.filter(
      (payload) => payload.agreementId === agreementId && payload.termIndex === expectation.termIndex,
    ),
  ).toEqual([expect.objectContaining({ obligorId: expectation.obligorId })]);
  expect(eventPayloads(value, "AgreementFulfilled")).toHaveLength(0);
}
