/**
 * 提供游戏模块的内容索引收窄断言与派系驻地解析。
 * 依赖 module-sdk 的内容视图类型；结构断言按 ReadonlyMap 接口能力检查各固定索引，不要求 Map 实例；
 * 只做结构断言与纯函数解析，不读取 YAML 或磁盘。
 * 禁止在这里修补缺失内容、生成默认业务值或替代启动时的内容校验。
 */
import type { GameContent, GameFaction } from "./game-ports";

/**
 * 判断值是否满足 ReadonlyMap 接口：size 为数字、可迭代且具备全部读取方法。
 * 类型契约只要求 ReadonlyMap，因此不按 Map 实例判断，自定义实现同样可以通过。
 */
function isReadonlyMap(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ReadonlyMap<unknown, unknown>>;
  return (
    typeof candidate.size === "number" &&
    typeof candidate[Symbol.iterator] === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.has === "function" &&
    typeof candidate.keys === "function" &&
    typeof candidate.values === "function" &&
    typeof candidate.entries === "function" &&
    typeof candidate.forEach === "function"
  );
}

/**
 * 把宿主注入的内容索引收窄为游戏端口视图；调用方必须在启动时完成真实内容校验。
 * 这里只做结构断言，不重新解析 YAML 或修补缺失字段。
 */
export function requireGameContent(content: unknown): GameContent {
  if (typeof content !== "object" || content === null) {
    throw new TypeError("游戏模块需要内容索引");
  }
  const candidate = content as Partial<GameContent>;
  if (
    !isReadonlyMap(candidate.nodes) ||
    !isReadonlyMap(candidate.roads) ||
    !isReadonlyMap(candidate.factions) ||
    !isReadonlyMap(candidate.characters) ||
    !isReadonlyMap(candidate.stockpiles) ||
    !isReadonlyMap(candidate.teams) ||
    !isReadonlyMap(candidate.groups) ||
    !isReadonlyMap(candidate.evidence) ||
    !isReadonlyMap(candidate.starts)
  ) {
    throw new TypeError("内容索引缺少游戏模块所需的固定索引");
  }
  return candidate as GameContent;
}

/**
 * 内容包声明的派系驻地节点：人类派系优先党部，其次前哨；外域派系只有领地。
 * 调用方只在内容包没有对应角色定义时使用本函数（人类 AI 党魁）；有角色定义的主体先取世界状态，
 * 世界状态缺少记录时位置未知，不能退回这里，否则任务移动后的最新位置会被静态驻地覆盖。
 */
export function factionStandingNode(
  faction: Pick<GameFaction, "factionHomeNodeId" | "outpostNodeId" | "territoryNodeId">,
): string | undefined {
  return faction.factionHomeNodeId ?? faction.outpostNodeId ?? faction.territoryNodeId;
}

/**
 * 判断主体是否直接持有章节规则声明的运营席（如公社席）：主体是派系且其 playerSeat 匹配。
 * AI 党魁以派系 ID 行动因此直接命中；玩家的 campaign 派系由调用方另行核对后传入 factionId。
 */
export function holdsOperationalSeat(content: GameContent, principalId: string): boolean {
  return content.factions.get(principalId)?.playerSeat === content.rules.watergateSeatId;
}

/**
 * 判断主体是否掌握公社水闸政策：持有公社席的派系主体直接命中（AI 党魁以派系 ID 行动）；
 * 玩家按已开局 campaign 的 playerId 与 factionId 裁决，campaign 由调用方从世界端口读取。
 * 世界的 `policy.set` 与协议的水闸条款校验共用这一份判定，避免两处口径分叉。
 */
export function controlsWatergate(
  content: GameContent,
  campaign: { readonly playerId: string; readonly factionId: string } | null,
  principalId: string,
): boolean {
  if (holdsOperationalSeat(content, principalId)) {
    return true;
  }
  return campaign !== null && campaign.playerId === principalId && holdsOperationalSeat(content, campaign.factionId);
}
