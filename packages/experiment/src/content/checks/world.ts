/**
 * 校验内容包世界数据之间的引用：地图、派系、角色、初态、证据、开局与剧情卡。
 * 依赖内容 schema 类型与共用失败辅助；只读取已解析的数据，不访问文件系统。
 * 禁止修补缺失引用、跳过错误或在该文件中构建索引。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions -- 内容 ID 已由 schema 约束为字符串；缺少完整类型信息时规则会把推断类型视为 unknown。 */
import { sourceIdSchema } from "@world-prism/contracts";
import type {
  ContentCard,
  ContentCharacters,
  ContentEvidenceEntry,
  ContentEvidence,
  ContentFaction,
  ContentFactions,
  ContentMap,
  ContentNode,
  ContentScenario,
  ContentStarts,
  ContentStockpile,
  ContentTeam,
  ContentWorldInit,
} from "@world-prism/contracts";
import { fail } from "./common";

/** 各内容文件在错误信息中的固定来源名。 */
const sources = {
  map: "map.yaml",
  factions: "factions.yaml",
  characters: "characters.yaml",
  worldInit: "world-init.yaml",
  evidence: "evidence.yaml",
  starts: "starts.yaml",
} as const;

/** 校验道路端点、控制方、初始状态与迁徙道路引用。 */
export function checkMap(
  map: ContentMap,
  nodes: ReadonlyMap<string, ContentNode>,
  factions: ReadonlyMap<string, ContentFaction>,
): void {
  map.roads.forEach((road, index) => {
    const path = `roads.${index}`;
    if (road.a === road.b) {
      fail(sources.map, `${path}.b`, `道路「${road.roadId}」两端指向同一节点`);
    }
    const endpoints = [
      { field: "a", nodeId: road.a },
      { field: "b", nodeId: road.b },
    ] as const;
    for (const endpoint of endpoints) {
      if (!nodes.has(endpoint.nodeId)) {
        fail(
          sources.map,
          `${path}.${endpoint.field}`,
          `道路「${road.roadId}」引用了不存在的节点「${endpoint.nodeId}」`,
        );
      }
    }
    if (road.controlledBy !== undefined) {
      if (!factions.has(road.controlledBy)) {
        fail(sources.map, `${path}.controlledBy`, `道路「${road.roadId}」的控制方「${road.controlledBy}」不存在`);
      }
    } else if (road.initialStatus !== undefined) {
      fail(sources.map, `${path}.initialStatus`, `不受控道路「${road.roadId}」不能声明初始通行状态`);
    }
  });
  map.migrationRoads.forEach((roadId, index) => {
    if (!map.roads.some((road) => road.roadId === roadId)) {
      fail(sources.map, `migrationRoads.${index}`, `迁徙道路「${roadId}」不存在`);
    }
  });
}

/** 校验派系驻地、角色所属派系、出生点与背景关系对象。 */
export function checkFactionsAndCharacters(
  factionsFile: ContentFactions,
  charactersFile: ContentCharacters,
  nodes: ReadonlyMap<string, ContentNode>,
  factions: ReadonlyMap<string, ContentFaction>,
  principalIds: ReadonlySet<string>,
): void {
  factionsFile.factions.forEach((faction, index) => {
    const path = `factions.${index}`;
    if (faction.kind === "human") {
      if (faction.factionHomeNodeId === undefined) {
        fail(sources.factions, `${path}.factionHomeNodeId`, `人类派系「${faction.factionId}」必须声明党部驻地`);
      } else if (!nodes.has(faction.factionHomeNodeId)) {
        fail(sources.factions, `${path}.factionHomeNodeId`, `派系「${faction.factionId}」的党部驻地「${faction.factionHomeNodeId}」不存在`);
      }
      if (faction.outpostNodeId === undefined) {
        fail(sources.factions, `${path}.outpostNodeId`, `人类派系「${faction.factionId}」必须声明前哨驻地`);
      } else if (!nodes.has(faction.outpostNodeId)) {
        fail(sources.factions, `${path}.outpostNodeId`, `派系「${faction.factionId}」的前哨驻地「${faction.outpostNodeId}」不存在`);
      }
    } else if (faction.territoryNodeId === undefined) {
      fail(sources.factions, `${path}.territoryNodeId`, `外域「${faction.factionId}」必须声明领地节点`);
    } else if (!nodes.has(faction.territoryNodeId)) {
      fail(sources.factions, `${path}.territoryNodeId`, `外域「${faction.factionId}」的领地「${faction.territoryNodeId}」不存在`);
    }
    faction.relations?.forEach((relation, relationIndex) => {
      if (!principalIds.has(relation.targetId)) {
        fail(
          sources.factions,
          `${path}.relations.${relationIndex}.targetId`,
          `派系「${faction.factionId}」的关系对象「${relation.targetId}」不存在`,
        );
      }
    });
  });
  const characterIds = new Set<string>();
  charactersFile.characters.forEach((character, index) => {
    const path = `characters.${index}`;
    if (character.characterId !== undefined) {
      if (characterIds.has(character.characterId)) {
        fail(sources.characters, `${path}.characterId`, `角色资产 ID「${character.characterId}」重复`);
      }
      characterIds.add(character.characterId);
    }
    if (!factions.has(character.factionId)) {
      fail(sources.characters, `${path}.factionId`, `角色「${character.agentId}」的派系「${character.factionId}」不存在`);
    }
    if (!nodes.has(character.spawnNodeId)) {
      fail(sources.characters, `${path}.spawnNodeId`, `角色「${character.agentId}」的出生点「${character.spawnNodeId}」不存在`);
    }
    character.initialRelations.forEach((relation, relationIndex) => {
      if (!principalIds.has(relation.targetId)) {
        fail(
          "characters.yaml",
          `${path}.initialRelations.${relationIndex}.targetId`,
          `角色「${character.agentId}」的关系对象「${relation.targetId}」不存在`,
        );
      }
    });
  });
}

/** 校验库存点、队伍、群体、职责委托与玩家初态。 */
export function checkWorldInit(
  init: ContentWorldInit,
  nodes: ReadonlyMap<string, ContentNode>,
  factions: ReadonlyMap<string, ContentFaction>,
  teams: ReadonlyMap<string, ContentTeam>,
  stockpiles: ReadonlyMap<string, ContentStockpile>,
  principalIds: ReadonlySet<string>,
): void {
  init.stockpiles.forEach((stockpile, index) => {
    const path = `stockpiles.${index}`;
    if (!nodes.has(stockpile.nodeId)) {
      fail(sources.worldInit, `${path}.nodeId`, `库存点「${stockpile.stockpileId}」所在节点「${stockpile.nodeId}」不存在`);
    }
    if (!factions.has(stockpile.ownerFactionId)) {
      fail(sources.worldInit, `${path}.ownerFactionId`, `库存点「${stockpile.stockpileId}」的所属派系「${stockpile.ownerFactionId}」不存在`);
    }
  });
  init.teams.forEach((team, index) => {
    const path = `teams.${index}`;
    if (!nodes.has(team.nodeId)) {
      fail(sources.worldInit, `${path}.nodeId`, `队伍「${team.teamId}」所在节点「${team.nodeId}」不存在`);
    }
    if (!factions.has(team.ownerFactionId)) {
      fail(sources.worldInit, `${path}.ownerFactionId`, `队伍「${team.teamId}」的所属派系「${team.ownerFactionId}」不存在`);
    }
  });
  init.groups.forEach((group, index) => {
    if (!nodes.has(group.nodeId)) {
      fail(sources.worldInit, `groups.${index}.nodeId`, `群体「${group.groupId}」所在节点「${group.nodeId}」不存在`);
    }
  });
  init.dutyDelegations.forEach((delegation, index) => {
    const path = `dutyDelegations.${index}`;
    if (!principalIds.has(delegation.granteeId)) {
      fail(sources.worldInit, `${path}.granteeId`, `职责委托的受托主体「${delegation.granteeId}」不存在`);
    }
    if (!factions.has(delegation.grantorFactionId)) {
      fail(sources.worldInit, `${path}.grantorFactionId`, `职责委托的委托方「${delegation.grantorFactionId}」不存在`);
    }
    delegation.teamIds.forEach((teamId, teamIndex) => {
      const team = teams.get(teamId);
      if (team === undefined) {
        fail(sources.worldInit, `${path}.teamIds.${teamIndex}`, `职责委托引用了不存在的队伍「${teamId}」`);
      }
      if (team.ownerFactionId !== delegation.grantorFactionId) {
        fail(sources.worldInit, `${path}.teamIds.${teamIndex}`, `队伍「${teamId}」不属于委托方「${delegation.grantorFactionId}」`);
      }
    });
    const stockpile = stockpiles.get(delegation.stockpileId);
    if (stockpile === undefined) {
      fail(sources.worldInit, `${path}.stockpileId`, `职责委托引用了不存在的库存点「${delegation.stockpileId}」`);
    }
    if (stockpile.ownerFactionId !== delegation.grantorFactionId) {
      fail(sources.worldInit, `${path}.stockpileId`, `库存点「${delegation.stockpileId}」不属于委托方「${delegation.grantorFactionId}」`);
    }
  });
  if (!nodes.has(init.player.nodeId)) {
    fail(sources.worldInit, "player.nodeId", `玩家所在节点「${init.player.nodeId}」不存在`);
  }
}

/** 校验证据与秘密的位置、持有者与可达性。 */
export function checkEvidence(
  evidenceFile: ContentEvidence,
  nodes: ReadonlyMap<string, ContentNode>,
  principalIds: ReadonlySet<string>,
): void {
  evidenceFile.evidence.forEach((entry, index) => {
    const path = `evidence.${index}`;
    if (entry.nodeId !== undefined && !nodes.has(entry.nodeId)) {
      fail(sources.evidence, `${path}.nodeId`, `证据「${entry.evidenceId}」所在节点「${entry.nodeId}」不存在`);
    }
    if (entry.nodeId === undefined && entry.discoverable === true) {
      fail(sources.evidence, `${path}.nodeId`, `可发现的证据「${entry.evidenceId}」必须声明所在节点`);
    }
    const hasHolders = entry.heldBy !== undefined && entry.heldBy.length > 0;
    const discoverableAtNode = entry.nodeId !== undefined && entry.discoverable === true;
    if (!hasHolders && !discoverableAtNode) {
      fail(sources.evidence, path, `证据「${entry.evidenceId}」既没有持有者，也不可通过侦察发现`);
    }
    entry.heldBy?.forEach((holder, holderIndex) => {
      if (!principalIds.has(holder)) {
        fail(sources.evidence, `${path}.heldBy.${holderIndex}`, `证据持有者「${holder}」不存在`);
      }
    });
  });
  evidenceFile.secrets.forEach((secret, index) => {
    secret.heldBy.forEach((holder, holderIndex) => {
      if (!principalIds.has(holder)) {
        fail(sources.evidence, `secrets.${index}.heldBy.${holderIndex}`, `秘密持有者「${holder}」不存在`);
      }
    });
  });
}

/** 校验五个开局引用的派系、队伍、库存点、知识与消息来源；contacts 可以是党魁或支持者。 */
export function checkStarts(
  startsFile: ContentStarts,
  factions: ReadonlyMap<string, ContentFaction>,
  teams: ReadonlyMap<string, ContentTeam>,
  stockpiles: ReadonlyMap<string, ContentStockpile>,
  evidence: ReadonlyMap<string, ContentEvidenceEntry>,
  principalIds: ReadonlySet<string>,
): void {
  startsFile.starts.forEach((start, index) => {
    const path = `starts.${index}`;
    const faction = factions.get(start.factionId);
    if (faction === undefined) {
      fail(sources.starts, `${path}.factionId`, `开局的派系「${start.factionId}」不存在`);
    }
    if (faction.kind !== "human") {
      fail(sources.starts, `${path}.factionId`, `只有人类派系可以有玩家开局，「${start.factionId}」不是人类派系`);
    }
    start.contacts.forEach((contact, contactIndex) => {
      if (!principalIds.has(contact)) {
        fail(sources.starts, `${path}.contacts.${contactIndex}`, `开局接触角色「${contact}」不存在`);
      }
    });
    start.playerDelegation.teamIds.forEach((teamId, teamIndex) => {
      const team = teams.get(teamId);
      if (team === undefined) {
        fail(sources.starts, `${path}.playerDelegation.teamIds.${teamIndex}`, `开局委托引用了不存在的队伍「${teamId}」`);
      }
      if (team.ownerFactionId !== start.factionId) {
        fail(sources.starts, `${path}.playerDelegation.teamIds.${teamIndex}`, `队伍「${teamId}」不属于开局派系「${start.factionId}」`);
      }
    });
    const stockpile = stockpiles.get(start.playerDelegation.stockpileId);
    if (stockpile === undefined) {
      fail(sources.starts, `${path}.playerDelegation.stockpileId`, `开局委托引用了不存在的库存点「${start.playerDelegation.stockpileId}」`);
    }
    if (stockpile.ownerFactionId !== start.factionId) {
      fail(sources.starts, `${path}.playerDelegation.stockpileId`, `库存点「${start.playerDelegation.stockpileId}」不属于开局派系「${start.factionId}」`);
    }
    start.knowledge.forEach((evidenceId, evidenceIndex) => {
      if (!evidence.has(evidenceId)) {
        fail(sources.starts, `${path}.knowledge.${evidenceIndex}`, `开局知识「${evidenceId}」不存在`);
      }
    });
    start.messages.forEach((message, messageIndex) => {
      if (!principalIds.has(message.from)) {
        fail(sources.starts, `${path}.messages.${messageIndex}.from`, `开局消息的发送者「${message.from}」不存在`);
      }
    });
  });
  const humanFactions = [...factions.values()].filter((faction) => faction.kind === "human");
  for (const faction of humanFactions) {
    const count = startsFile.starts.filter((start) => start.factionId === faction.factionId).length;
    if (count !== 1) {
      fail(sources.starts, "starts", `人类派系「${faction.factionId}」必须恰好有一个开局，当前有 ${count} 个`);
    }
  }
}

/** 剧情卡广播允许非 Agent 来源时，来源 ID 必须符合公共契约的 `src-` 形态。 */
function isSourceId(value: string): boolean {
  return sourceIdSchema.safeParse(value).success;
}

/**
 * 判断广播署名或消息来源是已登记主体还是剧情声明的 signature-only 署名。
 * 未上场的具名名单由剧情文件声明，内容加载与剧情模块共用同一份名单。
 */
function isKnownOrSignature(
  principalIds: ReadonlySet<string>,
  signatureOnlyIds: readonly string[],
  principalId: string,
): boolean {
  return principalIds.has(principalId) || signatureOnlyIds.includes(principalId);
}

/** 剧情卡跨文件校验所需的上下文；避免函数参数继续膨胀。 */
export interface ScenarioCheckContext {
  readonly file: string;
  readonly nodes: ReadonlyMap<string, ContentNode>;
  readonly factions: ReadonlyMap<string, ContentFaction>;
  readonly stockpiles: ReadonlyMap<string, ContentStockpile>;
  readonly principalIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
  /** 剧情声明的 signature-only 署名名单。 */
  readonly signatureOnlyIds: readonly string[];
}

/**
 * 校验剧情文件的元数据：广播发布节点、压力卡与 signature-only 名单。
 * signature-only 署名不得与已定义的身份重名，否则署名会实例化为角色。
 */
export function checkScenarioMeta(
  context: Omit<ScenarioCheckContext, "signatureOnlyIds">,
  scenario: ContentScenario,
): void {
  const { file, nodes, principalIds, agentIds } = context;
  if (!nodes.has(scenario.broadcastOriginNodeId)) {
    fail(file, "broadcastOriginNodeId", `广播发布节点「${scenario.broadcastOriginNodeId}」不存在`);
  }
  if (
    scenario.pressureCardId !== undefined &&
    !scenario.cards.some((card) => card.cardId === scenario.pressureCardId)
  ) {
    fail(file, "pressureCardId", `压力卡「${scenario.pressureCardId}」不在剧情卡列表中`);
  }
  const seen = new Set<string>();
  scenario.signatureOnlyPrincipalIds.forEach((principalId, index) => {
    if (seen.has(principalId)) {
      fail(file, `signatureOnlyPrincipalIds.${index}`, `signature-only 署名「${principalId}」重复声明`);
    }
    seen.add(principalId);
    if (agentIds.has(principalId) || principalIds.has(principalId)) {
      fail(file, `signatureOnlyPrincipalIds.${index}`, `signature-only 署名「${principalId}」与已定义的身份重名`);
    }
  });
}

/** 校验剧情卡效果引用的主体、节点、库存点与召集对象。 */
export function checkScenario(
  context: ScenarioCheckContext,
  card: ContentCard,
  cardIndex: number,
): void {
  const { file, nodes, factions, stockpiles, principalIds, agentIds, signatureOnlyIds } = context;
  card.effects.forEach((effect, effectIndex) => {
    const path = `cards.${cardIndex}.effects.${effectIndex}`;
    switch (effect.kind) {
      case "broadcast":
        if (!isKnownOrSignature(principalIds, signatureOnlyIds, effect.speakerId) && !isSourceId(effect.speakerId)) {
          fail(file, `${path}.speakerId`, `广播署名「${effect.speakerId}」不存在`);
        }
        break;
      case "message":
        if (!isKnownOrSignature(principalIds, signatureOnlyIds, effect.from)) {
          fail(file, `${path}.from`, `消息发送者「${effect.from}」不存在`);
        }
        effect.to.forEach((to, toIndex) => {
          if (!principalIds.has(to)) {
            fail(file, `${path}.to.${toIndex}`, `消息接收方「${to}」不存在`);
          }
        });
        break;
      case "rumor":
        effect.aboutIds.forEach((aboutId, aboutIndex) => {
          if (!principalIds.has(aboutId)) {
            fail(file, `${path}.aboutIds.${aboutIndex}`, `传闻对象「${aboutId}」不存在`);
          }
        });
        break;
      case "world-fact":
        if (effect.audience.kind === "node" && !nodes.has(effect.audience.nodeId)) {
          fail(file, `${path}.audience.nodeId`, `叙事事实的受众节点「${effect.audience.nodeId}」不存在`);
        }
        if (effect.audience.kind === "faction" && !factions.has(effect.audience.factionId)) {
          fail(file, `${path}.audience.factionId`, `叙事事实的受众派系「${effect.audience.factionId}」不存在`);
        }
        if (effect.audience.kind === "principals") {
          effect.audience.ids.forEach((principalId, principalIndex) => {
            if (!principalIds.has(principalId)) {
              fail(file, `${path}.audience.ids.${principalIndex}`, `叙事事实的受众「${principalId}」不存在`);
            }
          });
        }
        break;
      case "stockpile-adjust":
        if (!stockpiles.has(effect.stockpileId)) {
          fail(file, `${path}.stockpileId`, `库存调整引用了不存在的库存点「${effect.stockpileId}」`);
        }
        break;
      case "wake-agents":
        effect.agentIds.forEach((agentId, agentIndex) => {
          if (!agentIds.has(agentId)) {
            fail(file, `${path}.agentIds.${agentIndex}`, `召集对象「${agentId}」不是已激活的身份`);
          }
        });
        break;
    }
  });
}
