/**
 * 注册协议提出、回复、还价、生效、过期与违约/履约订阅。
 * 依赖协议聚合、内容索引、世界/地图/行动/通信端口与 authority 事务上下文。
 * 禁止替当事人记忆承诺，也禁止用未提交的任务事实提前判定履约。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents, security/detect-object-injection -- Codacy 缺少 workspace 类型解析；数组索引来自内部 terms/progress，资源键来自受限枚举。 */
import type { EventEnvelope, Json, Term } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  gameModuleIds,
  principalsAudience,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { readAgreementState, type AgreementState } from "./state";
import { termDeadline, validateTerms } from "./terms";

type AgreementContext = HandlerContext<GameModulePorts, unknown>;

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
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
    const deadline = termDeadline(term);
    if (deadline === null) {
      continue;
    }
    context.tx.schedule(
      "agreement.breach",
      deadline + 1,
      `agreement-breach:${state.agreementId}:${index}`,
      { agreementId: state.agreementId, termIndex: index },
    );
  }
}

function cancelAgreementJobs(context: AgreementContext, state: AgreementState): void {
  context.tx.cancelJobs(`agreement-expire:${state.agreementId}`);
  context.tx.cancelJobs(`agreement-breach:${state.agreementId}`);
}

function applyActivation(context: AgreementContext, state: AgreementState): void {
  for (const term of state.terms) {
    if (term.kind === "grant-passage") {
      asPorts(context)["game.map"].grantPassage({
        roadId: term.roadId,
        granteeFactionId: term.granteeFactionId,
        untilTick: term.untilTick,
        byId: term.obligorId,
      });
    } else if (term.kind === "water-allocation") {
      asPorts(context)["game.world"].setAllocation(term.policy, term.obligorId);
    } else if (term.kind === "delegate" && term.stockpileId !== null) {
      asPorts(context)["game.world"].createDelegation({
        grantorFactionId: asPorts(context)["game.world"].principalFaction(term.obligorId) ?? term.obligorId,
        granteeId: term.granteeId,
        teamIds: term.teamIds,
        stockpileId: term.stockpileId,
        maxDraw: term.maxDraw,
        untilTick: term.untilTick,
      });
    }
  }
}

function activate(context: AgreementContext, state: AgreementState): AgreementState {
  const activated: AgreementState = { ...state, status: "active", activatedAtTick: context.tx.worldTick };
  applyActivation(context, activated);
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
    if (term.kind === "delegate") {
      activated.fulfilledTerms = [...new Set([...activated.fulfilledTerms, index])];
      context.tx.emit(
        "AgreementTermFulfilled",
        { agreementId: activated.agreementId, termIndex: index, obligorId: term.obligorId, term, evidenceEventIds: [] },
        principalsAudience(activated.parties),
      );
    }
  }
  context.tx.put("agreement", activated.agreementId, activated);
  return finishIfFulfilled(context, activated);
}

function finishIfFulfilled(context: AgreementContext, state: AgreementState): AgreementState {
  if (state.fulfilledTerms.length !== state.terms.length) {
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
    activate(context, next);
  }
  return { kind: "accepted" };
}

function markBreach(context: AgreementContext, state: AgreementState, index: number): void {
  if (state.status !== "active" && state.status !== "breached") {
    return;
  }
  if (state.fulfilledTerms.includes(index) || state.breachedTerms.includes(index)) {
    return;
  }
  const term = state.terms[index];
  if (term === undefined) {
    return;
  }
  const next: AgreementState = {
    ...state,
    status: "breached",
    breachedTerms: [...state.breachedTerms, index],
  };
  context.tx.put("agreement", next.agreementId, next);
  context.tx.emit(
    "AgreementBreached",
    { agreementId: next.agreementId, termIndex: index, obligorId: term.obligorId, term },
    principalsAudience(next.parties),
  );
}

function fulfillTerm(context: AgreementContext, state: AgreementState, index: number, evidenceEventIds: readonly string[]): AgreementState {
  if (state.fulfilledTerms.includes(index)) {
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

function obligorMatchesTask(context: AgreementContext, obligorId: string, taskId: string): boolean {
  const task = asPorts(context)["game.actions"].task(taskId);
  if (task === null) {
    return false;
  }
  if (task.dispatcherId === obligorId) {
    return true;
  }
  const team = requireGameContent(context.content).teams.get(task.teamId);
  return team?.ownerFactionId === obligorId;
}

function taskFulfills(context: AgreementContext, term: Term, taskId: string): boolean {
  const task = asPorts(context)["game.actions"].task(taskId);
  if (task === null || task.status !== "completed" || task.completedAtTick === null || !obligorMatchesTask(context, term.obligorId, taskId)) {
    return false;
  }
  if (term.kind === "deliver") {
    if (task.taskType !== "transport") {
      return false;
    }
    const params = task.params as {
      readonly fromStockpileId?: string;
      readonly toStockpileId?: string;
      readonly cargo?: Record<string, number>;
    };
    return (
      params.fromStockpileId === term.fromStockpileId &&
      params.toStockpileId === term.toStockpileId &&
      (params.cargo?.[term.resource] ?? 0) > 0
    );
  }
  if (term.kind === "escort") {
    return task.taskType === "escort" && (task.params as { readonly roadId?: string }).roadId === term.roadId;
  }
  if (term.kind === "rescue") {
    return task.taskType === "rescue" && (task.params as { readonly groupId?: string }).groupId === term.groupId;
  }
  if (term.kind === "repair-relay") {
    return task.taskType === "repair";
  }
  return false;
}

function onTaskCompleted(context: AgreementContext, event: EventEnvelope): void {
  const payload = event.payload as { readonly taskId: string };
  const task = asPorts(context)["game.actions"].task(payload.taskId);
  if (task === null || task.completedAtTick === null) {
    return;
  }
  for (const entry of context.tx.list<AgreementState>("agreement")) {
    const state = entry.state;
    if (state.status !== "active" && state.status !== "breached") {
      continue;
    }
    if (state.activatedAtTick !== null && (task.completedAtTick as number) < state.activatedAtTick) {
      continue;
    }
    let current = state;
    for (const [index, term] of state.terms.entries()) {
      if (term.kind !== "deliver" || term.byTick < (task.completedAtTick as number) || !taskFulfills(context, term, payload.taskId)) {
        continue;
      }
      const params = task.params as { readonly cargo?: Record<string, number> };
      const progress = current.progress[index] ?? 0;
      const amount = params.cargo?.[term.resource] ?? 0;
      if (progress + amount >= term.amount) {
        current = fulfillTerm(context, current, index, [String(event.eventId)]);
      } else if (amount > 0) {
        const nextProgress = [...current.progress];
        nextProgress[index] = progress + amount;
        current = { ...current, progress: nextProgress };
        context.tx.put("agreement", current.agreementId, current);
      }
    }
    for (const [index, term] of state.terms.entries()) {
      if (term.kind === "deliver" || term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
        continue;
      }
      if (term.byTick < (task.completedAtTick as number) || !taskFulfills(context, term, payload.taskId)) {
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
    if (state.activatedAtTick !== null && context.tx.worldTick < state.activatedAtTick) {
      continue;
    }
    let current = state;
    for (const [index, term] of state.terms.entries()) {
      if (
        term.kind === "share-evidence" &&
        term.obligorId === payload.fromId &&
        term.evidenceId === payload.evidenceId &&
        payload.audience.includes(term.toPrincipalId) &&
        context.tx.worldTick <= term.byTick
      ) {
        current = fulfillTerm(context, current, index, [String(event.eventId)]);
      }
    }
  }
}

function onPolicyChanged(context: AgreementContext, event: EventEnvelope): void {
  const payload = event.payload as {
    readonly key: string;
    readonly newValue: string;
    readonly byId: string;
  };
  for (const entry of context.tx.list<AgreementState>("agreement")) {
    const state = entry.state;
    if (state.status !== "active" && state.status !== "breached") {
      continue;
    }
    for (const [index, term] of state.terms.entries()) {
      if (
        term.kind === "water-allocation" &&
        term.obligorId === payload.byId &&
        payload.key === "watergate.allocation" &&
        payload.newValue !== term.policy &&
        context.tx.worldTick <= term.untilTick
      ) {
        markBreach(context, state, index);
      }
      if (
        term.kind === "grant-passage" &&
        term.obligorId === payload.byId &&
        payload.key === `road.status:${term.roadId}` &&
        payload.newValue === "closed" &&
        context.tx.worldTick <= term.untilTick
      ) {
        markBreach(context, state, index);
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

function breach(context: AgreementContext, agreementId: string, termIndex: number): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null) {
    return;
  }
  const term = state.terms[termIndex];
  if (term === undefined) {
    return;
  }
  if (term.kind === "water-allocation") {
    if (asPorts(context)["game.world"].meters()?.["watergate.allocation"] === term.policy) {
      fulfillTerm(context, state, termIndex, []);
    } else {
      markBreach(context, state, termIndex);
    }
    return;
  }
  if (term.kind === "grant-passage") {
    if (asPorts(context)["game.map"].roadStatus(term.roadId) !== "closed") {
      fulfillTerm(context, state, termIndex, []);
    } else {
      markBreach(context, state, termIndex);
    }
    return;
  }
  markBreach(context, state, termIndex);
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
