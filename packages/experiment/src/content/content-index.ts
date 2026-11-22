/**
 * 建立内容包索引并编排跨文件一致性检查。
 * 依赖内容 schema 类型、各主题检查函数与共用 ID 辅助；输出只读索引供加载器与后续模块复用。
 * 禁止在此读取磁盘、修补缺失引用或跳过检查继续启动。
 */
/* eslint-disable @typescript-eslint/restrict-template-expressions -- 内容 ID 已由 schema 约束为字符串；缺少完整类型信息时规则会把推断类型视为 unknown。 */
import { checkScripts } from "./checks/scripts";
import { checkTemplates } from "./checks/templates";
import { checkEvidence, checkFactionsAndCharacters, checkMap, checkScenario, checkScenarioMeta, checkStarts, checkWorldInit } from "./checks/world";
import { checkRules } from "./checks/rules";
import { fail, registerGlobalIds, uniqueById } from "./checks/common";
import type {
  ContentCard,
  ContentCharacter,
  ContentCharacters,
  ContentEvidence,
  ContentEvidenceEntry,
  ContentFaction,
  ContentFactions,
  ContentGroup,
  ContentLocale,
  ContentLore,
  ContentMap,
  ContentNode,
  ContentPackFile,
  ContentPrompts,
  ContentRoad,
  ContentRules,
  ContentScenario,
  ContentScript,
  ContentSecret,
  ContentStart,
  ContentStarts,
  ContentStockpile,
  ContentTeam,
  ContentWorldInit,
} from "./schema/index";

/** 内容包全部文件解析后的部分，供索引构建使用。 */
export interface ContentParts {
  readonly pack: ContentPackFile;
  readonly lore: ContentLore;
  readonly map: ContentMap;
  readonly factions: ContentFactions;
  readonly characters: ContentCharacters;
  readonly worldInit: ContentWorldInit;
  readonly rules: ContentRules;
  readonly evidence: ContentEvidence;
  readonly starts: ContentStarts;
  readonly scenarios: ReadonlyMap<string, ContentScenario>;
  readonly scripts: ReadonlyMap<string, ContentScript>;
  readonly prompts: ContentPrompts;
  readonly locale: ContentLocale;
}

/** 内容包索引：固定 ID 到内容的只读映射与主体集合。 */
export interface ContentIndex {
  readonly nodes: ReadonlyMap<string, ContentNode>;
  readonly roads: ReadonlyMap<string, ContentRoad>;
  readonly factions: ReadonlyMap<string, ContentFaction>;
  readonly characters: ReadonlyMap<string, ContentCharacter>;
  readonly stockpiles: ReadonlyMap<string, ContentStockpile>;
  readonly teams: ReadonlyMap<string, ContentTeam>;
  readonly groups: ReadonlyMap<string, ContentGroup>;
  readonly evidence: ReadonlyMap<string, ContentEvidenceEntry>;
  readonly secrets: ReadonlyMap<string, ContentSecret>;
  readonly starts: ReadonlyMap<string, ContentStart>;
  readonly cards: ReadonlyMap<string, ContentCard>;
  readonly scenarios: ReadonlyMap<string, ContentScenario>;
  readonly scripts: ReadonlyMap<string, ContentScript>;
  readonly principalIds: ReadonlySet<string>;
  readonly agentIds: ReadonlySet<string>;
  readonly characterIds: ReadonlySet<string>;
  readonly factionIds: ReadonlySet<string>;
  readonly evidenceIds: ReadonlySet<string>;
  readonly secretIds: ReadonlySet<string>;
  readonly playerPrincipalId: string;
}

/** 内容文件在错误与全局 ID 登记中的固定来源名。 */
const contentFiles = {
  map: "map.yaml",
  factions: "factions.yaml",
  characters: "characters.yaml",
  worldInit: "world-init.yaml",
  evidence: "evidence.yaml",
  starts: "starts.yaml",
} as const;

/** 构建内容索引并完成领域模型要求的全部交叉检查。 */
export function buildContentIndex(parts: ContentParts): ContentIndex {
  const nodes = uniqueById(
    parts.map.nodes,
    (node) => node.nodeId,
    contentFiles.map,
    (index) => `nodes.${index}.nodeId`,
  );
  const roads = uniqueById(
    parts.map.roads,
    (road) => road.roadId,
    contentFiles.map,
    (index) => `roads.${index}.roadId`,
  );
  const factions = uniqueById(
    parts.factions.factions,
    (faction) => faction.factionId,
    contentFiles.factions,
    (index) => `factions.${index}.factionId`,
  );
  const characters = uniqueById(
    parts.characters.characters,
    (character) => character.agentId,
    contentFiles.characters,
    (index) => `characters.${index}.agentId`,
  );
  const stockpiles = uniqueById(
    parts.worldInit.stockpiles,
    (stockpile) => stockpile.stockpileId,
    contentFiles.worldInit,
    (index) => `stockpiles.${index}.stockpileId`,
  );
  const teams = uniqueById(
    parts.worldInit.teams,
    (team) => team.teamId,
    contentFiles.worldInit,
    (index) => `teams.${index}.teamId`,
  );
  const groups = uniqueById(
    parts.worldInit.groups,
    (group) => group.groupId,
    contentFiles.worldInit,
    (index) => `groups.${index}.groupId`,
  );
  const evidence = uniqueById(
    parts.evidence.evidence,
    (entry) => entry.evidenceId,
    contentFiles.evidence,
    (index) => `evidence.${index}.evidenceId`,
  );
  const secrets = uniqueById(
    parts.evidence.secrets,
    (secret) => secret.secretId,
    contentFiles.evidence,
    (index) => `secrets.${index}.secretId`,
  );
  const starts = uniqueById(
    parts.starts.starts,
    (start) => start.factionId,
    contentFiles.starts,
    (index) => `starts.${index}.factionId`,
  );

  const cards = new Map<string, ContentCard>();
  const cardEntries: { id: string; source: string; path: string }[] = [];
  for (const [file, scenario] of parts.scenarios) {
    scenario.cards.forEach((card, index) => {
      if (cards.has(card.cardId)) {
        fail(file, `cards.${index}`, `重复的剧情卡 ID「${card.cardId}」`);
      }
      cards.set(card.cardId, card);
      cardEntries.push({ id: card.cardId, source: file, path: `cards.${index}` });
    });
  }

  registerGlobalIds([
    ...[...nodes].map(([id, node]) => ({
      id,
      source: contentFiles.map,
      path: `nodes.${parts.map.nodes.indexOf(node)}`,
    })),
    ...[...roads].map(([id, road]) => ({
      id,
      source: contentFiles.map,
      path: `roads.${parts.map.roads.indexOf(road)}`,
    })),
    ...[...factions].map(([id, faction]) => ({
      id,
      source: contentFiles.factions,
      path: `factions.${parts.factions.factions.indexOf(faction)}`,
    })),
    ...[...characters]
      // 外域 Agent 的运行身份与 factionId 相同：派系与角色两份数据描述同一主体，只登记一次。
      .filter(([id, character]) => !(factions.get(id)?.kind === "species" && character.factionId === id))
      .map(([id, character]) => ({
        id,
        source: contentFiles.characters,
        path: `characters.${parts.characters.characters.indexOf(character)}`,
      })),
    ...[...stockpiles].map(([id, stockpile]) => ({
      id,
      source: contentFiles.worldInit,
      path: `stockpiles.${parts.worldInit.stockpiles.indexOf(stockpile)}`,
    })),
    ...[...teams].map(([id, team]) => ({
      id,
      source: contentFiles.worldInit,
      path: `teams.${parts.worldInit.teams.indexOf(team)}`,
    })),
    ...[...groups].map(([id, group]) => ({
      id,
      source: contentFiles.worldInit,
      path: `groups.${parts.worldInit.groups.indexOf(group)}`,
    })),
    ...[...evidence].map(([id, entry]) => ({
      id,
      source: contentFiles.evidence,
      path: `evidence.${parts.evidence.evidence.indexOf(entry)}`,
    })),
    ...[...secrets].map(([id, secret]) => ({
      id,
      source: contentFiles.evidence,
      path: `secrets.${parts.evidence.secrets.indexOf(secret)}`,
    })),
    ...cardEntries,
  ]);

  const factionIds = new Set(factions.keys());
  const characterIds = new Set(characters.keys());
  const agentIds = new Set([...factionIds, ...characterIds]);
  const playerPrincipalId = parts.worldInit.player.principalId;
  const principalIds = new Set([playerPrincipalId, ...agentIds]);
  if (agentIds.has(playerPrincipalId)) {
    fail("world-init.yaml", "player.principalId", `玩家主体「${playerPrincipalId}」与内容身份重名`);
  }

  checkMap(parts.map, nodes, factions);
  checkFactionsAndCharacters(parts.factions, parts.characters, nodes, factions, principalIds);
  checkWorldInit(parts.worldInit, nodes, factions, teams, stockpiles, principalIds);
  checkRules(parts.rules, parts.factions, nodes, roads, stockpiles, teams, agentIds);
  checkEvidence(parts.evidence, nodes, principalIds);
  checkStarts(parts.starts, factions, teams, stockpiles, evidence, principalIds);

  const scenariosById = new Map<string, ContentScenario>();
  for (const [file, scenario] of parts.scenarios) {
    if (scenario.scenarioId !== file.replace(/^scenarios\//, "").replace(/\.yaml$/, "")) {
      fail(file, "scenarioId", `剧情 ID「${scenario.scenarioId}」与文件名不一致`);
    }
    if (scenariosById.has(scenario.scenarioId)) {
      fail(file, "scenarioId", `重复的剧情 ID「${scenario.scenarioId}」`);
    }
    scenariosById.set(scenario.scenarioId, scenario);
    checkScenarioMeta({ file, nodes, factions, stockpiles, principalIds, agentIds }, scenario);
    scenario.cards.forEach((card, cardIndex) => {
      checkScenario(
        { file, nodes, factions, stockpiles, principalIds, agentIds, signatureOnlyIds: scenario.signatureOnlyPrincipalIds },
        card,
        cardIndex,
      );
    });
  }
  if (!scenariosById.has(parts.pack.defaultScenario)) {
    fail("pack.yaml", "defaultScenario", `默认剧情「${parts.pack.defaultScenario}」不在 scenarios 列表中`);
  }
  checkTemplates(parts.prompts, parts.locale, nodes);

  const scriptsById = new Map<string, ContentScript>();
  for (const [file, script] of parts.scripts) {
    if (scriptsById.has(script.scriptId)) {
      fail(file, "scriptId", `重复的脚本 ID「${script.scriptId}」`);
    }
    if (script.scriptId !== file.replace(/^scripts\//, "").replace(/\.yaml$/, "")) {
      fail(file, "scriptId", `脚本 ID「${script.scriptId}」与文件名不一致`);
    }
    scriptsById.set(script.scriptId, script);
  }

  const index: ContentIndex = {
    nodes,
    roads,
    factions,
    characters,
    stockpiles,
    teams,
    groups,
    evidence,
    secrets,
    starts,
    cards,
    scenarios: scenariosById,
    scripts: scriptsById,
    principalIds,
    agentIds,
    characterIds,
    factionIds,
    evidenceIds: new Set(evidence.keys()),
    secretIds: new Set(secrets.keys()),
    playerPrincipalId,
  };
  checkScripts(parts.scripts, index);
  return index;
}
