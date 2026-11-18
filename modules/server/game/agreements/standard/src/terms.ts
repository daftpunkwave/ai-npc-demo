/**
 * 校验协议条款：当事人、义务人、截止 tick 与条款所需的库存/队伍/道路/证据权限。
 * 依赖内容索引、世界/通信端口与公共条款 schema；只读，不写协议。
 * 禁止在这里执行条款效果或自动修正非法条款。
 */
import type { ReasonCode, Term } from "@ai-npc/contracts";
import {
  coversAmounts,
  requireGameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@ai-npc/module-sdk";

type TermContext = HandlerContext<GameModulePorts, unknown>;

/** 条款的截止 tick；delegate 无违约检查。 */
export function termDeadline(term: Term): number | null {
  if (term.kind === "grant-passage" || term.kind === "water-allocation") {
    return term.untilTick;
  }
  if (term.kind === "delegate") {
    return null;
  }
  return term.byTick;
}

/** 校验单条条款；合法返回 null。 */
export function validateTerm(context: TermContext, term: Term, parties: readonly string[]): ReasonCode | null {
  const content = requireGameContent(context.content);
  const ports = context.modules;
  if (!parties.includes(term.obligorId)) {
    return "obligor-not-party";
  }
  const deadline = termDeadline(term);
  if (deadline !== null && (deadline <= context.tx.worldTick || deadline > context.tx.worldTick + 168)) {
    return "deadline-out-of-range";
  }
  if (term.kind === "deliver") {
    if (!content.stockpiles.has(term.fromStockpileId) || !content.stockpiles.has(term.toStockpileId)) {
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

/** 校验全部条款；返回第一个非法原因。 */
export function validateTerms(context: TermContext, terms: readonly Term[], parties: readonly string[]): ReasonCode | null {
  for (const term of terms) {
    const invalid = validateTerm(context, term, parties);
    if (invalid !== null) {
      return invalid;
    }
  }
  return null;
}
