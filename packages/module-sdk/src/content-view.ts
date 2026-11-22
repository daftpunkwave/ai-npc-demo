/**
 * 提供游戏模块的内容索引收窄断言与派系驻地解析。
 * 依赖 module-sdk 的内容视图类型；只做结构断言与纯函数解析，不读取 YAML 或磁盘。
 * 禁止在这里修补缺失内容、生成默认业务值或替代启动时的内容校验。
 */
import type { GameContent, GameFaction } from "./game-ports";

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
    !(candidate.nodes instanceof Map) ||
    !(candidate.roads instanceof Map) ||
    !(candidate.factions instanceof Map) ||
    !(candidate.characters instanceof Map) ||
    !(candidate.stockpiles instanceof Map) ||
    !(candidate.teams instanceof Map) ||
    !(candidate.groups instanceof Map) ||
    !(candidate.evidence instanceof Map) ||
    !(candidate.starts instanceof Map)
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
