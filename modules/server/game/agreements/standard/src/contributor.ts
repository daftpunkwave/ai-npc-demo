/**
 * 注册协议提出、回复、还价、生效、过期与违约/履约订阅。
 * 依赖协议聚合、内容索引、世界/地图/行动/通信端口与 authority 事务上下文。
 * 禁止替当事人记忆承诺，也禁止用未提交的任务事实提前判定履约。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将端口泛型误判为 any。 */
import type { EventEnvelope, Json, ReasonCode, Term } from "@ai-npc/contracts";
import {
  coversAmounts,
  effectivePrincipalId,
  gameModuleIds,
  requireGameContent,
  type GameModulePorts,
  type GameRuleContributor,
  type HandlerContext,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { readAgreementState, type AgreementState } from "./state";

type AgreementContext = HandlerContext<GameModulePorts, unknown>;

function asPorts(context: { readonly modules: unknown }): GameModulePorts {
  return context.modules as GameModulePorts;
}

function termDeadline(term: Term): number | null {
  if (term.kind === "grant-passage" || term.kind === "water-allocation") {
    return term.untilTick;
  }
  if (term.kind === "delegate") {
    return null;
  }
  return term.byTick;
}

function validateTerm(context: AgreementContext, term: Term, parties: readonly string[]): ReasonCode | null {
  const content = requireGameContent(context.content);
  const ports = asPorts(context);
  if (!parties.includes(term.obligorId)) {
    return "obligor-not-party";
  }
  const deadline = termDeadline(term);
  if (deadline !== null && (deadline <= context.tx.worldTick || deadline > context.tx.worldTick + 168)) {
    return "deadline-out-of-range";
  }
  if (term.kind === "deliver") {
    if (
      !content.stockpiles.has(term.fromStockpileId) ||
      !content.stockpiles.has(term.toStockpileId)
    ) {
      return "invalid-terms";
    }
    const authority = ports["game.world"].drawAuthority(term.obligorId, term.fromStockpileId);
    if (authority.kind === "none") {
      return "invalid-terms";
    }
    if (authority.kind === "delegation") {
      const requested = { supply: 0, energy: 0, medical: 0, [term.resource]: term.amount } as never;
      if (!coversAmounts(authority.remaining, requested)) {
        return "draw-limit-exceeded";
      }
    }
  } else if (term.kind === "escort") {
    if (!content.roads.has(term.roadId)) {
      return "invalid-terms";
    }
  } else if (term.kind === "rescue") {
    const group = ports["game.world"].group(term.groupId);
    if (group === null || group.status === "rescued") {
      return "invalid-terms";
    }
  } else if (term.kind === "share-evidence") {
    if (!ports["game.comms"].holds(term.obligorId, term.evidenceId)) {
      return "invalid-terms";
    }
  } else if (term.kind === "grant-passage") {
    const road = content.roads.get(term.roadId);
    if (road === undefined || road.controlledBy === undefined) {
      return "invalid-terms";
    }
    if (ports["game.world"].principalFaction(term.obligorId) !== road.controlledBy) {
      return "invalid-terms";
    }
  } else if (term.kind === "water-allocation") {
    if (term.obligorId !== "human-neutral") {
      return "invalid-terms";
    }
  } else if (term.kind === "delegate") {
    if (term.stockpileId === null) {
      return "invalid-terms";
    }
    for (const teamId of term.teamIds) {
      if (!content.teams.has(teamId)) {
        return "invalid-terms";
      }
    }
    if (!content.stockpiles.has(term.stockpileId)) {
      return "invalid-terms";
    }
  }
  return null;
}

function validateTerms(context: AgreementContext, terms: readonly Term[], parties: readonly string[]): ReasonCode | null {
  for (const term of terms) {
    const invalid = validateTerm(context, term, parties);
    if (invalid !== null) {
      return invalid;
    }
  }
  return null;
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
  const activated: AgreementState = { ...state, status: "active" };
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
    [{ kind: "public" }],
  );
  scheduleBreaches(context, activated);
  context.tx.cancelJobs(`agreement-expire:${activated.agreementId}`);
  for (const [index, term] of activated.terms.entries()) {
    if (term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
      activated.fulfilledTerms = [...new Set([...activated.fulfilledTerms, index])];
      context.tx.emit(
        "AgreementTermFulfilled",
        { agreementId: activated.agreementId, termIndex: index, obligorId: term.obligorId, term, evidenceEventIds: [] },
        [{ kind: "public" }],
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
  context.tx.emit("AgreementFulfilled", { agreementId: fulfilled.agreementId }, [{ kind: "public" }]);
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
    [{ kind: "public" }],
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
  if (state.responses[actor] === "accept") {
    return { kind: "rejected", reasonCode: "already-responded", safeMessage: "已经回复过该提案" };
  }
  context.tx.emit(
    "AgreementResponded",
    { agreementId: state.agreementId, partyId: actor, response: input.response },
    [{ kind: "principals", ids: [...state.parties] }],
  );
  if (input.response === "reject") {
    context.tx.put("agreement", state.agreementId, { ...state, status: "rejected", responses: { ...state.responses, [actor]: "reject" } });
    context.tx.emit("AgreementRejected", { agreementId: state.agreementId, byId: actor }, [{ kind: "public" }]);
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
    context.tx.emit("AgreementSuperseded", { agreementId: state.agreementId, byId: actor }, [{ kind: "public" }]);
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
      [{ kind: "public" }],
    );
    cancelAgreementJobs(context, state);
    scheduleExpiry(context, next);
    return { kind: "accepted", result: { agreementId: next.agreementId } };
  }
  const responses = { ...state.responses, [actor]: "accept" as const };
  const next = { ...state, responses };
  context.tx.put("agreement", next.agreementId, next);
  if (next.parties.every((party) => responses[party] === "accept")) {
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
    [{ kind: "public" }],
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
    [{ kind: "public" }],
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
    for (const [index, term] of state.terms.entries()) {
      if (term.kind !== "deliver" || term.byTick < (task.completedAtTick as number) || !taskFulfills(context, term, payload.taskId)) {
        continue;
      }
      const params = task.params as { readonly cargo?: Record<string, number> };
      const progress = state.progress[index] ?? 0;
      const amount = params.cargo?.[term.resource] ?? 0;
      if (progress + amount >= term.amount) {
        fulfillTerm(context, state, index, [String(event.eventId)]);
      } else if (amount > 0) {
        const nextProgress = [...state.progress];
        nextProgress[index] = progress + amount;
        context.tx.put("agreement", state.agreementId, { ...state, progress: nextProgress });
      }
    }
    for (const [index, term] of state.terms.entries()) {
      if (term.kind === "deliver" || term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
        continue;
      }
      if (term.byTick < (task.completedAtTick as number) || !taskFulfills(context, term, payload.taskId)) {
        continue;
      }
      fulfillTerm(context, state, index, [String(event.eventId)]);
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
    for (const [index, term] of state.terms.entries()) {
      if (
        term.kind === "share-evidence" &&
        term.obligorId === payload.fromId &&
        term.evidenceId === payload.evidenceId &&
        payload.audience.includes(term.toPrincipalId) &&
        context.tx.worldTick <= term.byTick
      ) {
        fulfillTerm(context, state, index, [String(event.eventId)]);
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
  context.tx.emit("AgreementExpired", { agreementId, byId: null }, [{ kind: "public" }]);
}

function breach(context: AgreementContext, agreementId: string, termIndex: number): void {
  const state = readAgreementState(context.tx, agreementId);
  if (state === null) {
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
      { consumerId: "agreement-task-completed", eventTypes: ["TaskCompleted"], handler: (context, event) => onTaskCompleted(context as AgreementContext, event) },
      { consumerId: "agreement-information-shared", eventTypes: ["InformationShared"], handler: (context, event) => onInformationShared(context as AgreementContext, event) },
      { consumerId: "agreement-policy-changed", eventTypes: ["PolicyChanged"], handler: (context, event) => onPolicyChanged(context as AgreementContext, event) },
    ],
  };
}
