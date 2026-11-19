/**
 * 注册协议提出、回复、还价、生效、过期与违约/履约订阅。
 * 依赖协议聚合、内容索引、世界/地图/行动/通信端口与 authority 事务上下文。
 * 履约与违约一律按事实发生的 tick 判定：事件消费用 event.worldTick，任务类用权威完成 tick；
 * 只有协议生效之后的事实才算履约；期限 job 先按已提交事实复核，再按政策/道路状态判定持续义务。
 * 禁止替当事人记忆承诺，也禁止用未提交的任务事实提前判定履约。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, security/detect-object-injection -- Codacy 缺少 workspace 类型解析；数组索引来自内部 terms/progress，资源键来自受限枚举。 */
import type { EventEnvelope, Json, ReasonCode, Term } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  gameModuleIds,
  principalsAudience,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
  type ShareQuery,
} from "@ai-npc/module-sdk";
import {
  cargoAmount,
  hasOpenSustainedObligation,
  isSustainedTerm,
  isTermSatisfied,
  taskMatchesTerm,
  taskServesObligor,
  type FulfillmentFacts,
} from "./fulfillment";
import { readAgreementState, type AgreementState } from "./state";
import { termDeadline, validateTerms } from "./terms";

type AgreementContext = HandlerContext<GameModulePorts, unknown>;

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

/** 队伍所属派系；内容包里没有的队伍返回 null，按「不属于义务人」处理。 */
function teamOwnerFaction(context: AgreementContext, teamId: string): string | null {
  return requireGameContent(context.content).teams.get(teamId)?.ownerFactionId ?? null;
}

/**
 * 本事务内的已提交履约事实：已完成任务来自行动端口，分享来自通信端口。
 * 只读端口，不改写其他模块聚合。
 */
function fulfillmentFacts(context: AgreementContext): FulfillmentFacts {
  const ports = asPorts(context);
  return {
    completedTasks: ports["game.actions"].completedTasks(),
    hasShare: (query: ShareQuery) => ports["game.comms"].hasShare(query),
    factionOfTeam: (teamId) => teamOwnerFaction(context, teamId),
  };
}

function initialState(
  context: AgreementContext,
  terms: readonly Term[],
  parties: readonly string[],
  proposerId: string,
  supersedesId: string | null,
  version: number,
  expiresAtTick: number,
): AgreementState {
  return {
    agreementId: context.ids("agr"),
    version,
    proposerId,
    parties: [...parties],
    terms: [...terms],
    responses: { [proposerId]: "accept" },
    status: "proposed",
    createdAtTick: context.tx.worldTick,
    activatedAtTick: null,
    expiresAtTick,
    supersedesId,
    supersededBy: null,
    fulfilledTerms: [],
    breachedTerms: [],
    progress: terms.map(() => 0),
  };
}

function scheduleExpiry(context: AgreementContext, state: AgreementState): void {
  context.tx.schedule("agreement.expire", state.expiresAtTick, `agreement-expire:${state.agreementId}`, {
    agreementId: state.agreementId,
  });
}

function scheduleBreaches(context: AgreementContext, state: AgreementState): void {
  for (const [index, term] of state.terms.entries()) {
    // delegate 生效即履约，首版没有撤销命令，不安排违约检查。
    // 其余条款在期限 +1 的 job 上复核；通行与水闸的期限是 untilTick，该 job 同时负责收尾。
    if (term.kind === "delegate") {
      continue;
    }
    context.tx.schedule(
      "agreement.breach",
      termDeadline(term) + 1,
      `agreement-breach:${state.agreementId}:${index}`,
      { agreementId: state.agreementId, termIndex: index },
    );
  }
}

function cancelAgreementJobs(context: AgreementContext, state: AgreementState): void {
  context.tx.cancelJobs(`agreement-expire:${state.agreementId}`);
  context.tx.cancelJobs(`agreement-breach:${state.agreementId}`);
}

/** 生效写入的结果；失败由 respond 转成拒绝，命令网关回滚整个保存点。 */
type ActivationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

function applyActivation(context: AgreementContext, state: AgreementState): ActivationResult {
  const ports = asPorts(context);
  for (const term of state.terms) {
    if (term.kind === "grant-passage") {
      const granted = ports["game.map"].grantPassage({
        roadId: term.roadId,
        granteeFactionId: term.granteeFactionId,
        untilTick: term.untilTick,
        byId: term.obligorId,
      });
      if (!granted.ok) {
        return { ok: false, reasonCode: granted.reasonCode, safeMessage: "通行许可未能创建" };
      }
    } else if (term.kind === "water-allocation") {
      const applied = ports["game.world"].setAllocation(term.policy, term.obligorId);
      // no-change 表示当前分配已等于条款值，条款本已符合，不算写入失败。
      if (!applied.ok && applied.reasonCode !== "no-change") {
        return { ok: false, reasonCode: applied.reasonCode, safeMessage: "水闸分配未能写入" };
      }
    } else if (term.kind === "delegate") {
      ports["game.world"].createDelegation({
        grantorFactionId: ports["game.world"].principalFaction(term.obligorId) ?? term.obligorId,
        granteeId: term.granteeId,
        teamIds: term.teamIds,
        stockpileId: term.stockpileId,
        maxDraw: term.maxDraw,
        untilTick: term.untilTick,
      });
    }
  }
  return { ok: true };
}

function activate(context: AgreementContext, state: AgreementState): ActivationResult {
  const activated: AgreementState = { ...state, status: "active", activatedAtTick: context.tx.worldTick };
  const applied = applyActivation(context, activated);
  if (!applied.ok) {
    return applied;
  }
  context.tx.put("agreement", activated.agreementId, activated);
  context.tx.emit(
    "AgreementActivated",
    {
      agreementId: activated.agreementId,
      version: activated.version,
      parties: [...activated.parties],
      terms: [...activated.terms],
    },
    principalsAudience(activated.parties),
  );
  scheduleBreaches(context, activated);
  context.tx.cancelJobs(`agreement-expire:${activated.agreementId}`);
  for (const [index, term] of activated.terms.entries()) {
    // 委托没有撤销命令；通行与水闸生效即履约，持续义务由 untilTick 后的期限 job 收尾。
    if (term.kind === "delegate" || isSustainedTerm(term)) {
      activated.fulfilledTerms = [...new Set([...activated.fulfilledTerms, index])];
      context.tx.emit(
        "AgreementTermFulfilled",
        { agreementId: activated.agreementId, termIndex: index, obligorId: term.obligorId, term, evidenceEventIds: [] },
        principalsAudience(activated.parties),
      );
    }
  }
  context.tx.put("agreement", activated.agreementId, activated);
  finishIfFulfilled(context, activated);
  return { ok: true };
}

/** 义务期尚未结束的通行/水闸条款仍可能违约，协议此时不能整体标为 fulfilled。 */
function hasOpenObligation(context: AgreementContext, state: AgreementState): boolean {
  return hasOpenSustainedObligation(state, context.tx.worldTick);
}

function finishIfFulfilled(context: AgreementContext, state: AgreementState): AgreementState {
  // 只有仍然生效的协议能收尾；已违约或已关闭的协议不再被后续履约改写。
  if (state.status !== "active") {
    return state;
  }
  if (state.fulfilledTerms.length !== state.terms.length || hasOpenObligation(context, state)) {
    return state;
  }
  const fulfilled: AgreementState = { ...state, status: "fulfilled" };
  context.tx.put("agreement", fulfilled.agreementId, fulfilled);
  context.tx.emit("AgreementFulfilled", { agreementId: fulfilled.agreementId }, principalsAudience(fulfilled.parties));
  cancelAgreementJobs(context, fulfilled);
  return fulfilled;
}

function propose(context: AgreementContext, payload: Json): HandlerResult {
  const input = payload as unknown as {
    readonly parties: readonly string[];
    readonly terms: readonly Term[];
    readonly expiresInTicks?: number;
  };
  const proposerId = effectivePrincipalId(context.auth);
  if (!input.parties.includes(proposerId)) {
    return { kind: "rejected", reasonCode: "not-a-party", safeMessage: "提出者必须是当事人" };
  }
  const invalid = validateTerms(context, input.terms, input.parties);
  if (invalid !== null) {
    return { kind: "rejected", reasonCode: invalid, safeMessage: "协议条款不合法" };
  }
  const expiresAtTick = context.tx.worldTick + Math.min(input.expiresInTicks ?? 24, 168);
  const state = initialState(context, input.terms, input.parties, proposerId, null, 1, expiresAtTick);
  context.tx.put("agreement", state.agreementId, state);
  context.tx.emit(
    "AgreementProposed",
    {
      agreementId: state.agreementId,
      version: state.version,
      proposerId,
      parties: [...state.parties],
      terms: [...state.terms],
      expiresAtTick,
      supersedesId: null,
    },
    principalsAudience(state.parties),
  );
  scheduleExpiry(context, state);
  return { kind: "accepted", result: { agreementId: state.agreementId } };
}

function respond(context: AgreementContext, payload: Json): HandlerResult {
  const input = payload as unknown as {
    readonly agreementId: string;
    readonly response: "accept" | "reject" | "counter";
    readonly counterTerms?: readonly Term[];
  };
  const actor = effectivePrincipalId(context.auth);
  const state = readAgreementState(context.tx, input.agreementId);
  if (state === null) {
    return { kind: "rejected", reasonCode: "not-a-party", safeMessage: "协议不存在" };
  }
  if (!state.parties.includes(actor)) {
    return { kind: "rejected", reasonCode: "not-a-party", safeMessage: "当前主体不是当事人" };
  }
  if (state.status !== "proposed") {
    return { kind: "rejected", reasonCode: "agreement-not-open", safeMessage: "协议已经关闭" };
  }
  const responseMap = new Map(Object.entries(state.responses));
  if (responseMap.get(actor) === "accept") {
    return { kind: "rejected", reasonCode: "already-responded", safeMessage: "已经回复过该提案" };
  }
  context.tx.emit(
    "AgreementResponded",
    { agreementId: state.agreementId, partyId: actor, response: input.response },
    principalsAudience(state.parties),
  );
  if (input.response === "reject") {
    responseMap.set(actor, "reject");
    context.tx.put("agreement", state.agreementId, { ...state, status: "rejected", responses: Object.fromEntries(responseMap) });
    context.tx.emit("AgreementRejected", { agreementId: state.agreementId, byId: actor }, principalsAudience(state.parties));
    cancelAgreementJobs(context, state);
    return { kind: "accepted" };
  }
  if (input.response === "counter") {
    const terms = input.counterTerms ?? [];
    const invalid = validateTerms(context, terms, state.parties);
    if (invalid !== null) {
      return { kind: "rejected", reasonCode: invalid, safeMessage: "还价条款不合法" };
    }
    const next = initialState(
      context,
      terms,
      state.parties,
      actor,
      state.agreementId,
      state.version + 1,
      context.tx.worldTick + 24,
    );
    context.tx.put("agreement", state.agreementId, { ...state, status: "superseded", supersededBy: next.agreementId });
    context.tx.put("agreement", next.agreementId, next);
    context.tx.emit("AgreementSuperseded", { agreementId: state.agreementId, byId: actor }, principalsAudience(state.parties));
    context.tx.emit(
      "AgreementProposed",
      {
        agreementId: next.agreementId,
        version: next.version,
        proposerId: actor,
        parties: [...next.parties],
        terms: [...next.terms],
        expiresAtTick: next.expiresAtTick,
        supersedesId: state.agreementId,
      },
      principalsAudience(next.parties),
    );
    cancelAgreementJobs(context, state);
    scheduleExpiry(context, next);
    return { kind: "accepted", result: { agreementId: next.agreementId } };
  }
  const responses = Object.fromEntries(new Map([...Object.entries(state.responses), [actor, "accept" as const]]));
  const next = { ...state, responses };
  context.tx.put("agreement", next.agreementId, next);
  const acceptedByAll = next.parties.every((party) => new Map(Object.entries(responses)).get(party) === "accept");
  if (acceptedByAll) {
    const invalid = validateTerms(context, next.terms, next.parties);
    if (invalid !== null) {
      return { kind: "rejected", reasonCode: invalid, safeMessage: "条款在生效前已失效" };
    }
    // 生效写入失败时按该原因码拒绝，保存点回滚后不保留回复与部分生效写入。
    const activation = activate(context, next);
    if (!activation.ok) {
      return { kind: "rejected", reasonCode: activation.reasonCode, safeMessage: activation.safeMessage };
    }
  }
  return { kind: "accepted" };
}

/**
 * 记录一条条款违约并返回最新状态。
 * 同一事件可能命中同一协议的多条条款，调用方必须串联返回值，不能各自基于旧状态写入。
 */
function markBreach(context: AgreementContext, state: AgreementState, index: number): AgreementState {
  if (state.status !== "active" && state.status !== "breached" && state.status !== "fulfilled") {
    return state;
  }
  if (state.breachedTerms.includes(index)) {
    return state;
  }
  const term = state.terms[index];
  if (term === undefined) {
    return state;
  }
  // 通行与水闸条款生效即记为履约，但义务期内的违反仍要记录；其余条款履约后不再违约。
  if (state.fulfilledTerms.includes(index) && !isSustainedTerm(term)) {
    return state;
  }
  const next: AgreementState = {
    ...state,
    status: "breached",
    breachedTerms: [...state.breachedTerms, index],
    fulfilledTerms: state.fulfilledTerms.filter((value) => value !== index),
  };
  context.tx.put("agreement", next.agreementId, next);
  context.tx.emit(
    "AgreementBreached",
    { agreementId: next.agreementId, termIndex: index, obligorId: term.obligorId, term },
    principalsAudience(next.parties),
  );
  return next;
}

function fulfillTerm(context: AgreementContext, state: AgreementState, index: number, evidenceEventIds: readonly string[]): AgreementState {
  // 已关闭的协议不再记录新的履约；已记录的违约是不可回退的事实，后续履约证据不能把它改写成履约。
  if (state.status !== "active" && state.status !== "breached") {
    return state;
  }
  if (state.fulfilledTerms.includes(index) || state.breachedTerms.includes(index)) {
    return state;
  }
  const term = state.terms[index];
  if (term === undefined) {
    return state;
  }
  const next: AgreementState = {
    ...state,
    fulfilledTerms: [...state.fulfilledTerms, index],
  };
  context.tx.put("agreement", next.agreementId, next);
  context.tx.emit(
    "AgreementTermFulfilled",
    { agreementId: next.agreementId, termIndex: index, obligorId: term.obligorId, term, evidenceEventIds: [...evidenceEventIds] },
    principalsAudience(next.parties),
  );
  return finishIfFulfilled(context, next);
}

function onTaskCompleted(context: AgreementContext, event: EventEnvelope): void {
  const payload = event.payload as { readonly taskId: string };
  const task = asPorts(context)["game.actions"].task(payload.taskId);
  if (task === null || task.completedAtTick === null) {
    return;
  }
  // 任务的 completedAtTick 是权威完成 tick，与消费者何时追平无关。
  const completedAtTick = task.completedAtTick;
  const factionOfTeam = (teamId: string) => teamOwnerFaction(context, teamId);
  for (const entry of context.tx.list<AgreementState>("agreement")) {
    const state = entry.state;
    if (state.status !== "active" && state.status !== "breached") {
      continue;
    }
    if (state.activatedAtTick !== null && completedAtTick < state.activatedAtTick) {
      continue;
    }
    let current = state;
    for (const [index, term] of current.terms.entries()) {
      if (
        term.kind !== "deliver" ||
        completedAtTick > term.byTick ||
        !taskMatchesTerm(term, task) ||
        !taskServesObligor(term.obligorId, task, factionOfTeam)
      ) {
        continue;
      }
      const amount = cargoAmount(task, term.resource);
      const progress = current.progress[index] ?? 0;
      if (progress + amount >= term.amount) {
        current = fulfillTerm(context, current, index, [String(event.eventId)]);
      } else if (amount > 0) {
        const nextProgress = [...current.progress];
        nextProgress[index] = progress + amount;
        current = { ...current, progress: nextProgress };
        context.tx.put("agreement", current.agreementId, current);
      }
    }
    for (const [index, term] of current.terms.entries()) {
      if (
        term.kind === "deliver" ||
        term.kind === "grant-passage" ||
        term.kind === "water-allocation" ||
        term.kind === "delegate"
      ) {
        continue;
      }
      if (
        completedAtTick > term.byTick ||
        !taskMatchesTerm(term, task) ||
        !taskServesObligor(term.obligorId, task, factionOfTeam)
      ) {
        continue;
      }
      current = fulfillTerm(context, current, index, [String(event.eventId)]);
    }
  }
}

function onInformationShared(context: AgreementContext, event: EventEnvelope): void {
  const payload = event.payload as unknown as {
    readonly fromId: string;
    readonly evidenceId: string;
    readonly audience: readonly string[];
  };
  for (const entry of context.tx.list<AgreementState>("agreement")) {
    const state = entry.state;
    if (state.status !== "active" && state.status !== "breached") {
      continue;
    }
    // 分享发生在生效前或期限后都不算履约；用事件自己的 worldTick，不用消费时钟。
    if (state.activatedAtTick !== null && event.worldTick < state.activatedAtTick) {
      continue;
    }
    let current = state;
    for (const [index, term] of current.terms.entries()) {
      if (term.kind !== "share-evidence") {
        continue;
      }
      if (
        term.obligorId !== payload.fromId ||
        term.evidenceId !== payload.evidenceId ||
        !payload.audience.includes(term.toPrincipalId) ||
        event.worldTick > term.byTick
      ) {
        continue;
      }
      current = fulfillTerm(context, current, index, [String(event.eventId)]);
    }
  }
}

/** 政策事件是否构成某条水闸/通行条款在义务期内的违约。 */
function policyBreachAt(
  term: Term,
  payload: { readonly key: string; readonly newValue: string; readonly byId: string },
  eventTick: number,
): boolean {
  if (term.kind === "water-allocation") {
    return (
      payload.key === "watergate.allocation" &&
      term.obligorId === payload.byId &&
      payload.newValue !== term.policy &&
      eventTick <= term.untilTick
    );
  }
  if (term.kind === "grant-passage") {
    return (
      payload.key === `road.status:${term.roadId}` &&
      term.obligorId === payload.byId &&
      payload.newValue === "closed" &&
      eventTick <= term.untilTick
    );
  }
  return false;
}

function onPolicyChanged(context: AgreementContext, event: EventEnvelope): void {
  const payload = event.payload as {
    readonly key: string;
    readonly newValue: string;
    readonly byId: string;
  };
  for (const entry of context.tx.list<AgreementState>("agreement")) {
    const state = entry.state;
    if (state.status !== "active" && state.status !== "breached" && state.status !== "fulfilled") {
      continue;
    }
    if (state.activatedAtTick !== null && event.worldTick < state.activatedAtTick) {
      continue;
    }
    // 一次政策事件可能命中同一协议的多条条款，按最新状态逐条累积，不能互相覆盖。
    let current = state;
    for (const [index, term] of current.terms.entries()) {
      if (policyBreachAt(term, payload, event.worldTick)) {
        current = markBreach(context, current, index);
      }
    }
  }
}

function expire(context: AgreementContext, agreementId: string): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null || state.status !== "proposed") {
    return;
  }
  context.tx.put("agreement", agreementId, { ...state, status: "expired" });
  context.tx.emit("AgreementExpired", { agreementId, byId: null }, principalsAudience(state.parties));
}

/** 通行与水闸的持续义务：义务期内义务人改了政策或关闭道路即为违约。 */
function sustainedObligationViolated(context: AgreementContext, term: Term): boolean {
  if (term.kind === "water-allocation") {
    return asPorts(context)["game.world"].meters()?.["watergate.allocation"] !== term.policy;
  }
  if (term.kind === "grant-passage") {
    return asPorts(context)["game.map"].roadStatus(term.roadId) === "closed";
  }
  return false;
}

function breach(context: AgreementContext, agreementId: string, termIndex: number): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null) {
    return;
  }
  const term = state.terms[termIndex];
  if (term === undefined) {
    return;
  }
  let current = state;
  // 期限 job 可能先于消费者处理已提交的履约证据：先用生效后的已提交事实复核，满足即补记履约。
  // 生效前完成的任务或分享不算履约；期限 job 只在生效后安排，activatedAtTick 缺失时按 0 处理。
  if (
    sustainedObligationViolated(context, term) ||
    !isTermSatisfied(term, fulfillmentFacts(context), state.activatedAtTick ?? 0)
  ) {
    current = markBreach(context, current, termIndex);
  } else {
    current = fulfillTerm(context, current, termIndex, []);
  }
  finishIfFulfilled(context, current);
}

/** 协议模块的规则贡献。 */
export function createAgreementsContributor(): GameRuleContributor<GameModulePorts, unknown> {
  return {
    moduleId: gameModuleIds.agreements,
    ownsAggregates: ["agreement"],
    commands: [
      { type: "agreement.propose", handler: (context, payload) => propose(context as AgreementContext, payload) },
      { type: "agreement.respond", handler: (context, payload) => respond(context as AgreementContext, payload) },
    ],
    jobs: [
      {
        kind: "agreement.expire",
        handler: (context, job) => {
          expire(context as AgreementContext, (job.payload as { readonly agreementId: string }).agreementId);
        },
      },
      {
        kind: "agreement.breach",
        handler: (context, job) => {
          const payload = job.payload as { readonly agreementId: string; readonly termIndex: number };
          breach(context as AgreementContext, payload.agreementId, payload.termIndex);
        },
      },
    ],
    consumers: [
      { consumerId: "agreement-task-completed", eventTypes: ["TaskCompleted"], handler: (context, event) => { onTaskCompleted(context as AgreementContext, event); } },
      { consumerId: "agreement-information-shared", eventTypes: ["InformationShared"], handler: (context, event) => { onInformationShared(context as AgreementContext, event); } },
      { consumerId: "agreement-policy-changed", eventTypes: ["PolicyChanged"], handler: (context, event) => { onPolicyChanged(context as AgreementContext, event); } },
    ],
  };
}
