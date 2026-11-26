/**
 * 校验协议条款：当事人、义务人、截止 tick 与条款所需的库存/队伍/道路/证据权限。
 * 依赖内容索引、世界/通信端口与公共条款 schema；只读，不写协议。
 * 禁止在这里执行条款效果或自动修正非法条款。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将端口泛型误判为 any。 */
import type { ReasonCode, Term } from "@world-prism/contracts";
import {
  controlsWatergate,
  coversAmounts,
  requireGameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@world-prism/module-sdk";

type TermContext = HandlerContext<GameModulePorts, unknown>;

/** 条款的截止 tick；八种条款都有期限，delegate 的期限只用于校验，不安排违约检查。 */
export function termDeadline(term: Term): number {
  if (term.kind === "grant-passage" || term.kind === "water-allocation" || term.kind === "delegate") {
    return term.untilTick;
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
  // 截止窗口是一个章节长度，取自世界端口；与提案的期限上限共用同一权威值。
  if (deadline <= context.tx.worldTick || deadline > context.tx.worldTick + ports["game.world"].chapterLengthTicks()) {
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
    // 地图端口按战略 Agent 主体的 ID 判断控制权，不接受同派系的角色或玩家代签。
    if (road.controlledBy !== term.obligorId) {
      return "invalid-terms";
    }
  } else if (term.kind === "water-allocation") {
    // 水闸义务人必须掌握水闸政策：与世界 policy.set 共用同一判定，不能用其他派系或未开局身份代签。
    if (!controlsWatergate(content, ports["game.world"].campaign(), term.obligorId)) {
      return "invalid-terms";
    }
  } else if (term.kind === "delegate") {
    // 义务人必须是队伍/库存点所属派系的战略 Agent；普通受托人的可使用授权不能再次签发。
    if (!content.factions.has(term.obligorId)) {
      return "invalid-terms";
    }
    for (const teamId of term.teamIds) {
      const team = content.teams.get(teamId);
      if (team === undefined || team.ownerFactionId !== term.obligorId) {
        return "invalid-terms";
      }
    }
    // stockpileId 为 null 表示只委托队伍，不附带任何库存动用权。
    if (term.stockpileId !== null) {
      const stockpile = content.stockpiles.get(term.stockpileId);
      if (stockpile === undefined || stockpile.ownerFactionId !== term.obligorId) {
        return "invalid-terms";
      }
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
