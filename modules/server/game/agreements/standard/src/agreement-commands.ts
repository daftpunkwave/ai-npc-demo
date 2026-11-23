/**
 * 协议命令处理器：提出、接受/拒绝/还价，以及全部当事人接受后的生效写入。
 * 依赖条款校验、协议聚合、世界/地图端口与事务上下文；不评估期限后的履约或违约。
 * 禁止替当事人应答、跳过生效前校验，或在写入失败时保留部分生效结果。
 */
import type { Json, ReasonCode, Term } from "@ai-npc/contracts";
import { commandPayloadOf } from "@ai-npc/contracts";
import {
  effectivePrincipalId,
  principalsAudience,
  requireGameContent,
  type HandlerResult,
} from "@ai-npc/module-sdk";
import { isSustainedTerm } from "./fulfillment";
import { finishIfFulfilled } from "./agreement-lifecycle";
import { cancelAgreementJobs, scheduleBreaches, scheduleExpiry } from "./agreement-schedule";
import { asPorts, type AgreementContext } from "./agreement-shared";
import { readAgreementState, type AgreementState } from "./state";
import { validateTerms } from "./terms";

/** 协议允许的最长有效期；与公共契约 payload 的允许范围保持一致。 */
const maxAgreementWindowTicks = 168;

/**
 * 协议允许的最大版本号。版本在每次还价时加一，限制版本即限制还价次数：
 * 避免反复还价把提案无限期拖下去，也让客户端能以有界历史展示协商过程。
 */
const maxAgreementVersion = 5;

/**
 * 校验当事人中每个主体都是当前世界可承担的已知主体：
 * 内容角色、派系战略 Agent（含人类党魁与外域 Agent）或当前 campaign 的玩家。
 * 只确认存在性，具体条款权限仍由条款校验与生效写入裁决。
 */
function findUnknownParty(context: AgreementContext, parties: readonly string[]): string | null {
  const content = requireGameContent(context.content);
  const campaignPlayerId = context.modules["game.world"].campaign()?.playerId;
  for (const party of parties) {
    const known = content.characters.has(party) || content.factions.has(party) || party === campaignPlayerId;
    if (!known) {
      return party;
    }
  }
  return null;
}

/** 新提案的初始状态；提出者默认已接受，其余当事人待回复。 */
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

/** 生效写入本身的结果；失败由 respond 转成拒绝，命令网关回滚整个保存点。 */
type ActivationWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

/** 生效后的协议状态，供 respond 构造固定的工具 result。 */
type ActivationResult =
  | { readonly ok: true; readonly status: AgreementState["status"] }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

/** 按条款创建授权：通行许可、水闸分配与队伍/库存委托。 */
function applyActivation(context: AgreementContext, state: AgreementState): ActivationWriteResult {
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

/** 生效：写状态、发布激活事件、安排违约检查，并把生效即履约的条款记为履约。 */
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
  const finished = finishIfFulfilled(context, activated);
  return { ok: true, status: finished.status };
}

/** 提出协议：提出者在当事人内、当事人都是已知主体、条款需通过校验；期限超过 168 tick 时显式拒绝。 */
export function propose(context: AgreementContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("agreement.propose", payload);
  const proposerId = effectivePrincipalId(context.auth);
  if (!input.parties.includes(proposerId)) {
    return { kind: "rejected", reasonCode: "not-a-party", safeMessage: "提出者必须是当事人" };
  }
  const unknownParty = findUnknownParty(context, input.parties);
  if (unknownParty !== null) {
    return {
      kind: "rejected",
      reasonCode: "unknown-party",
      safeMessage: `协议当事人 ${unknownParty} 不是当前世界中的已知主体`,
    };
  }
  const invalid = validateTerms(context, input.terms, input.parties);
  if (invalid !== null) {
    return { kind: "rejected", reasonCode: invalid, safeMessage: "协议条款不合法" };
  }
  if (input.expiresInTicks > maxAgreementWindowTicks) {
    return {
      kind: "rejected",
      reasonCode: "deadline-out-of-range",
      safeMessage: `协议有效期不能超过 ${maxAgreementWindowTicks} tick`,
    };
  }
  const expiresAtTick = context.tx.worldTick + input.expiresInTicks;
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

/** 应答协议：拒绝关闭提案，还价生成新版本，最后一位接受者触发生效。 */
export function respond(context: AgreementContext, payload: Json): HandlerResult {
  const input = commandPayloadOf("agreement.respond", payload);
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
    return { kind: "accepted", result: { agreementId: state.agreementId, agreementStatus: "rejected" } };
  }
  if (input.response === "counter") {
    if (state.version >= maxAgreementVersion) {
      return {
        kind: "rejected",
        reasonCode: "counter-limit-reached",
        safeMessage: `还价次数已达上限（最多 ${maxAgreementVersion} 个版本）`,
      };
    }
    const terms = input.counterTerms ?? [];
    const invalid = validateTerms(context, terms, state.parties);
    if (invalid !== null) {
      return { kind: "rejected", reasonCode: invalid, safeMessage: "还价条款不合法" };
    }
    // 还价只替换条款与提出者，不重置到期时间：协商不能延长原提案的生命周期。
    const next = initialState(
      context,
      terms,
      state.parties,
      actor,
      state.agreementId,
      state.version + 1,
      state.expiresAtTick,
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
    return { kind: "accepted", result: { agreementId: next.agreementId, agreementStatus: "proposed" } };
  }
  const responses = Object.fromEntries(new Map([...Object.entries(state.responses), [actor, "accept" as const]]));
  const next = { ...state, responses };
  context.tx.put("agreement", next.agreementId, next);
  const acceptedByAll = next.parties.every((party) => new Map(Object.entries(responses)).get(party) === "accept");
  let activation: ActivationResult | undefined;
  if (acceptedByAll) {
    const invalid = validateTerms(context, next.terms, next.parties);
    if (invalid !== null) {
      return { kind: "rejected", reasonCode: invalid, safeMessage: "条款在生效前已失效" };
    }
    // 生效写入失败时按该原因码拒绝，保存点回滚后不保留回复与部分生效写入。
    activation = activate(context, next);
    if (!activation.ok) {
      return { kind: "rejected", reasonCode: activation.reasonCode, safeMessage: activation.safeMessage };
    }
  }
  return {
    kind: "accepted",
    result: {
      agreementId: next.agreementId,
      agreementStatus: activation?.ok ? activation.status : "proposed",
    },
  };
}
