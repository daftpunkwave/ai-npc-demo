/**
 * 协议事件消费者：任务完成、信息分享与政策变化按事件自身 tick 记履约或违约。
 * 依赖协议聚合、行动/通信只读端口、履约判定辅助与状态转换；不修改任务或分享事实。
 * 禁止用消费时钟判断时效、在生效前的事实上记履约，或让后一次写入覆盖前一次违约。
 */
import type { EventEnvelope, Term } from "@ai-npc/contracts";
import type { AgreementState } from "./state";
import { cargoAmount, taskMatchesTerm, taskServesObligor } from "./fulfillment";
import { fulfillTerm, markBreach } from "./agreement-lifecycle";
import { asPorts, teamOwnerFaction, type AgreementContext } from "./agreement-shared";

/** 任务完成事件：按权威完成 tick 判定交付与其它任务类条款的履约。 */
export function onTaskCompleted(context: AgreementContext, event: EventEnvelope): void {
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
      // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件的条款遍历，不来自外部输入。
      const progress = current.progress[index] ?? 0;
      if (progress + amount >= term.amount) {
        current = fulfillTerm(context, current, index, [String(event.eventId)]);
      } else if (amount > 0) {
        const nextProgress = [...current.progress];
        // eslint-disable-next-line security/detect-object-injection -- 索引来自本文件的条款遍历，不来自外部输入。
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

/** 信息分享事件：分享发生在生效前或期限后都不算履约；用事件自己的 worldTick。 */
export function onInformationShared(context: AgreementContext, event: EventEnvelope): void {
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

/** 政策变化事件：一次事件可能命中同一协议的多条条款，必须按最新状态逐条累积。 */
export function onPolicyChanged(context: AgreementContext, event: EventEnvelope): void {
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
