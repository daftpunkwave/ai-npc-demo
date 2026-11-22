/**
 * 核心职责：由投影规则从当前可见状态派生玩家的提醒通知。
 * 交互契约：输入为协议、任务、指标与收件箱视图；不读事件流。
 * 约束与禁忌：提醒文案在投影内固定；派生规则只依据输入视图的公开字段。
 */
import type {
  AgreementView,
  InboxItemView,
  PlayerMetersView,
  PlayerNotificationView,
  PlayerTaskView,
  TermKind,
} from "@ai-npc/contracts";

/** 协议到期提醒窗口：玩家协议 24 tick 内到期。 */
const agreementDeadlineWindowTicks = 24;

/**
 * 投影派生的提醒文案。内容包目前没有提醒类 locale 键，先在投影内固定；
 * 后续接入内容包时只替换文案来源，派生规则不变。
 */
const notificationTexts = {
  invite: "收到新的协议提案",
  deadline: `协议条款将在 ${agreementDeadlineWindowTicks} tick 内到期`,
  failedTask: "委托的任务已失败",
  crisis: "局势指标处于危急",
} as const;

function termDeadline(kind: TermKind, term: { readonly byTick?: number; readonly untilTick?: number }): number | null {
  if (kind === "grant-passage" || kind === "water-allocation" || kind === "delegate") {
    return term.untilTick ?? null;
  }
  return term.byTick ?? null;
}

/**
 * 提醒：由投影规则从当前可见状态派生，不读事件流。
 * invite 是收到协议提案；deadline 是玩家协议 24 tick 内到期；
 * urgent 是自己的任务失败或指标处于危急；public 是已送达的公开广播。
 */
export function notificationViews(input: {
  readonly agreements: readonly AgreementView[];
  readonly owns: readonly PlayerTaskView[];
  readonly meters: PlayerMetersView | null;
  readonly inbox: readonly InboxItemView[];
  readonly playerPrincipalId: string;
  readonly tick: number;
}): PlayerNotificationView[] {
  const { agreements, owns, meters, inbox, playerPrincipalId, tick } = input;
  const items: PlayerNotificationView[] = [];
  for (const agreement of agreements) {
    if (agreement.status === "proposed" && agreement.proposerId !== playerPrincipalId) {
      items.push({ kind: "invite", text: notificationTexts.invite, worldTick: tick });
      continue;
    }
    if (agreement.status !== "active") {
      continue;
    }
    const nearDeadline = agreement.terms.some((term) => {
      if (term.status !== "open") {
        return false;
      }
      const deadline = termDeadline(term.term.kind, term.term);
      return deadline !== null && deadline > tick && deadline <= tick + agreementDeadlineWindowTicks;
    });
    if (nearDeadline) {
      items.push({ kind: "deadline", text: notificationTexts.deadline, worldTick: tick });
    }
  }
  for (const task of owns) {
    if (task.taskStatus === "failed") {
      items.push({ kind: "urgent", text: notificationTexts.failedTask, worldTick: tick });
    }
  }
  if (meters !== null) {
    const readings = [meters.relayStability, meters.orchardWater, meters.migrationSafety];
    if (readings.some((reading) => reading.level === "critical")) {
      items.push({ kind: "urgent", text: notificationTexts.crisis, worldTick: tick });
    }
  }
  for (const item of inbox) {
    if (item.kind === "broadcast") {
      items.push({ kind: "public", text: item.text, worldTick: item.worldTick });
    }
  }
  return items;
}
