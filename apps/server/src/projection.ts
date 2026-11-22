/**
 * 构建玩家可见投影：只从世界/地图/通信/资源/行动/协议端口与内容索引读取公开字段。
 * 依赖玩家投影 schema、内容与模块端口；不读取 Agent 私有记忆、领域事件流或模型输出。
 * 禁止把内部任务风险、秘密正文、未发布剧情卡或风险抽样结果直接放入投影。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将投影联合类型误判为 any。 */
import {
  playerProjectionSchema,
  type AgreementView,
  type CharacterView,
  type ClockView,
  type ConversationLine,
  type InboxItemView,
  type NotebookEntryView,
  type PlayerMetersView,
  type PlayerNotificationView,
  type PlayerProjection,
  type PlayerTaskView,
  type StockpileView,
  type TeamView,
  type TermKind,
} from "@ai-npc/contracts";
import { addAmounts, factionStandingNode, meterLevel } from "@ai-npc/module-sdk";
import type {
  AgreementView as AgreementPortView,
  GameActionsPort,
  GameAgreementsPort,
  GameCommsPort,
  GameContent,
  GameMapPort,
  GameResourcesPort,
  GameWorldPort,
  TaskView,
} from "@ai-npc/module-sdk";

/** 会话对白与收件箱的保留条数；与 API 第 3 节的会话分页上限一致取最近 50 条。 */
const conversationLineLimit = 50;
const inboxItemLimit = 50;

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

/** 投影输入：world/map 必填，其余游戏端口可选。 */
export interface PlayerProjectionInput {
  readonly content: GameContent;
  readonly clock: ClockView;
  readonly world: GameWorldPort;
  readonly map: GameMapPort;
  /** 通信端口：缺省时不输出会话、收件箱、知识笔记与待回复角色。 */
  readonly comms?: GameCommsPort;
  /** 资源端口：缺省时不输出库存点。 */
  readonly resources?: GameResourcesPort;
  /** 行动端口：缺省时不输出任务。 */
  readonly actions?: GameActionsPort;
  /** 协议端口：缺省时不输出协议与到期提醒。 */
  readonly agreements?: GameAgreementsPort;
  /** 玩家主体 ID；缺省用内容包声明的玩家主体。 */
  readonly playerPrincipalId?: string;
  /** 玩家显示名；缺省用主体 ID。 */
  readonly playerName?: string;
  /** 正在排队或执行 turn 的角色；由宿主调度器提供，缺省视为没有待回复。 */
  readonly awaitingReplyCharacters?: readonly string[];
}

function metersView(world: GameWorldPort): PlayerMetersView | null {
  const value = world.meters();
  if (value === null) {
    return null;
  }
  return {
    relayStability: { value: value["relay.stability"], level: meterLevel(value["relay.stability"]) },
    orchardWater: { value: value["orchard.water"], level: meterLevel(value["orchard.water"]) },
    migrationSafety: { value: value["migration.safety"], level: meterLevel(value["migration.safety"]) },
    watergateAllocation: value["watergate.allocation"],
  };
}

/**
 * 库存点：等级公开；精确数量与委托余额只给当前仍持有该库存点委托的玩家。
 * 资源聚合尚未初始化时（开局前）没有精确事实，直接输出空集合，不按内容初值伪造。
 */
function stockpileViews(input: {
  readonly content: GameContent;
  readonly resources: GameResourcesPort | undefined;
  readonly delegations: ReturnType<GameWorldPort["delegationsOf"]>;
  readonly tick: number;
}): StockpileView[] {
  const { content, resources, delegations, tick } = input;
  if (resources === undefined) {
    return [];
  }
  const views: StockpileView[] = [];
  for (const init of content.stockpiles.values()) {
    const stockpile = resources.stockpile(init.stockpileId);
    if (stockpile === null) {
      continue;
    }
    const activeDelegations = delegations.filter(
      (candidate) => candidate.stockpileId === init.stockpileId && candidate.untilTick >= tick,
    );
    const delegation =
      activeDelegations.length === 0
        ? null
        : {
            remaining: activeDelegations.reduce(
              (remaining, candidate) => addAmounts(remaining, candidate.remaining),
              { supply: 0, energy: 0, medical: 0 },
            ),
            untilTick: Math.min(...activeDelegations.map((candidate) => candidate.untilTick)),
          };
    const levels = resources.level(init.stockpileId);
    views.push({
      stockpileId: stockpile.stockpileId,
      nodeId: stockpile.nodeId,
      ownerFactionId: stockpile.ownerFactionId,
      supplyLevel: levels.supply,
      energyLevel: levels.energy,
      medicalLevel: levels.medical,
      amounts: delegation === null ? null : stockpile.amount,
      delegation,
    });
  }
  return views.sort((left, right) => left.stockpileId.localeCompare(right.stockpileId));
}

/** 队伍：位置、所属与状态公开；仍有效的玩家委托覆盖的队伍标 delegatedToMe。 */
function teamViews(input: {
  readonly world: GameWorldPort;
  readonly delegations: ReturnType<GameWorldPort["delegationsOf"]>;
  readonly tick: number;
}): TeamView[] {
  const delegatedTeamIds = new Set<string>();
  for (const delegation of input.delegations) {
    if (delegation.untilTick < input.tick) {
      continue;
    }
    for (const teamId of delegation.teamIds) {
      delegatedTeamIds.add(teamId);
    }
  }
  return input.world
    .teams()
    .map((team) => ({
      teamId: team.teamId,
      nodeId: team.nodeId,
      ownerFactionId: team.ownerFactionId,
      status: team.status,
      delegatedToMe: delegatedTeamIds.has(team.teamId),
    }))
    .sort((left, right) => left.teamId.localeCompare(right.teamId));
}

/** 角色：世界状态提供位置与伤势，内容索引提供名称、派系、职责与公开主张。 */
function characterViews(input: {
  readonly content: GameContent;
  readonly world: GameWorldPort;
  readonly tick: number;
}): CharacterView[] {
  const views: CharacterView[] = [];
  const present = new Set<string>();
  for (const state of input.world.characters()) {
    const definition = input.content.characters.get(state.agentId);
    if (definition === undefined) {
      continue;
    }
    views.push({
      agentId: state.agentId,
      name: definition.name,
      factionId: definition.factionId,
      role: definition.role,
      nodeId: state.nodeId,
      injured: state.injuredUntilTick !== null && state.injuredUntilTick > input.tick,
      injuredUntilTick: state.injuredUntilTick,
      publicClaim: definition.values[0] ?? null,
    });
    present.add(state.agentId);
  }
  if (input.world.campaign() !== null) {
    for (const faction of input.content.factions.values()) {
      // 有角色定义的主体只从世界状态取位置；内容包驻地只补无角色定义的人类 AI 党魁。
      if (
        present.has(faction.factionId) ||
        input.content.characters.has(faction.factionId) ||
        faction.leaderName === undefined
      ) {
        continue;
      }
      const presentation = faction as typeof faction & {
        readonly playerSeat?: string;
        readonly persona?: {
          readonly role?: string;
          readonly values?: readonly string[];
        };
      };
      if (presentation.playerSeat !== undefined) {
        continue;
      }
      // 内容包没有角色定义的人类 AI 党魁用派系驻地补位，与通信的位置口径共用同一纯函数。
      const nodeId = factionStandingNode(faction);
      if (nodeId === undefined) {
        continue;
      }
      views.push({
        agentId: faction.factionId as CharacterView["agentId"],
        name: faction.leaderName,
        factionId: faction.factionId,
        role: presentation.persona?.role ?? `${faction.name}党魁`,
        nodeId: nodeId as CharacterView["nodeId"],
        injured: false,
        injuredUntilTick: null,
        publicClaim: presentation.persona?.values?.[0] ?? null,
      });
    }
  }
  return views.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/** 自己的任务给出完整参数与两个状态列；参数由投影 schema 按 taskType 复核。 */
function ownTaskView(task: TaskView): PlayerTaskView {
  return {
    kind: "own",
    taskId: task.taskId,
    taskType: task.taskType,
    teamId: task.teamId,
    participants: [...task.participants],
    params: task.params as PlayerTaskView["params"],
    commandStatus: "accepted",
    taskStatus: task.status,
    departTick: task.departTick,
    nominalCompletionTick: task.nominalCompletionTick,
    delayNoticeSent: task.delayNoticeSent,
    route: null,
  };
}

/** 其他任务只暴露「某队伍在路上」与路线，不含任务类型、参数、参与者与内部风险。 */
function otherTaskView(teamId: string, task: TaskView): PlayerTaskView {
  return {
    kind: "other",
    taskId: null,
    taskType: null,
    teamId,
    participants: [],
    params: null,
    commandStatus: null,
    taskStatus: null,
    departTick: null,
    nominalCompletionTick: null,
    delayNoticeSent: false,
    route: [...task.route],
  };
}

/**
 * 任务：玩家派遣或参与的任务走完整视图；其他队伍正在途中的任务只按队伍给出路线摘要。
 * 队伍当前任务的路线只从行动端口读取，不读取任务的风险抽样结果。
 */
function taskViews(input: {
  readonly actions: GameActionsPort | undefined;
  readonly world: GameWorldPort;
  readonly playerPrincipalId: string;
}): PlayerTaskView[] {
  const { actions, world, playerPrincipalId } = input;
  if (actions === undefined) {
    return [];
  }
  const ownTasks = actions.tasksOf(playerPrincipalId);
  const ownTaskIds = new Set(ownTasks.map((task) => task.taskId));
  const views = ownTasks
    .map(ownTaskView)
    .sort((left, right) => (left.taskId ?? "").localeCompare(right.taskId ?? ""));
  const summaries: PlayerTaskView[] = [];
  for (const team of world.teams()) {
    if (team.status !== "traveling" || team.currentTaskId === null || ownTaskIds.has(team.currentTaskId)) {
      continue;
    }
    const task = actions.task(team.currentTaskId);
    if (task === null || task.route.length === 0) {
      continue;
    }
    summaries.push(otherTaskView(team.teamId, task));
  }
  summaries.sort((left, right) => left.teamId.localeCompare(right.teamId));
  return [...views, ...summaries];
}

function termStatus(agreement: AgreementPortView, index: number): "open" | "fulfilled" | "breached" {
  if (agreement.breachedTerms.includes(index)) {
    return "breached";
  }
  return agreement.fulfilledTerms.includes(index) ? "fulfilled" : "open";
}

/** 协议：只给玩家是当事人的协议，含逐条状态与累计进度。 */
function agreementViews(
  agreements: GameAgreementsPort | undefined,
  playerPrincipalId: string,
): AgreementView[] {
  if (agreements === undefined) {
    return [];
  }
  return agreements
    .agreementsOf(playerPrincipalId)
    .map((agreement) => ({
      agreementId: agreement.agreementId,
      version: agreement.version,
      proposerId: agreement.proposerId,
      parties: [...agreement.parties],
      terms: agreement.terms.map((term, index) => ({
        term,
        status: termStatus(agreement, index),
        progress: agreement.progress.at(index) ?? null,
      })),
      status: agreement.status,
      expiresAtTick: agreement.expiresAtTick,
      supersedesId: agreement.supersedesId,
    }))
    .sort((left, right) => left.agreementId.localeCompare(right.agreementId));
}

function speakerNameOf(
  content: GameContent,
  speakerId: string,
  playerPrincipalId: string,
  playerName: string | undefined,
): string {
  const character = content.characters.get(speakerId);
  if (character !== undefined) {
    return character.name;
  }
  return speakerId === playerPrincipalId ? (playerName ?? speakerId) : speakerId;
}

/**
 * 会话：玩家参与的会话最近 50 条对白。
 * 只保留已按冻结投递名单送达玩家的对白，未到送达 tick 的行不出现。
 */
function conversationLines(input: {
  readonly content: GameContent;
  readonly comms: GameCommsPort | undefined;
  readonly playerPrincipalId: string;
  readonly playerName: string | undefined;
  readonly tick: number;
}): ConversationLine[] {
  const { content, comms, playerPrincipalId, playerName, tick } = input;
  if (comms === undefined) {
    return [];
  }
  const delivered: { readonly conversationId: string; readonly line: ConversationLine }[] = [];
  for (const conversationId of comms.conversationsOf(playerPrincipalId)) {
    for (const line of comms.conversationMessages(conversationId, conversationLineLimit)) {
      const delivery = line.deliveries.find((candidate) => candidate.principalId === playerPrincipalId);
      if (delivery === undefined || delivery.deliverAtTick > tick) {
        continue;
      }
      delivered.push({
        conversationId,
        line: {
          seq: line.seq,
          dialogueId: line.dialogueId,
          speakerId: line.speakerId,
          speakerName: speakerNameOf(content, line.speakerId, playerPrincipalId, playerName),
          text: line.text,
          worldTick: line.worldTick,
          channel: line.channel,
        },
      });
    }
  }
  return delivered
    .sort(
      (left, right) =>
        left.line.worldTick - right.line.worldTick ||
        left.conversationId.localeCompare(right.conversationId) ||
        left.line.seq - right.line.seq,
    )
    .map((entry) => entry.line)
    .slice(-conversationLineLimit);
}

/** 收件箱：已送达玩家的消息、公开广播与传闻；来源与「传闻」由 kind 标明。 */
function inboxItems(comms: GameCommsPort | undefined, playerPrincipalId: string): InboxItemView[] {
  if (comms === undefined) {
    return [];
  }
  const items: InboxItemView[] = [];
  for (const message of comms.messagesFor(playerPrincipalId, inboxItemLimit)) {
    if (message.fromId === playerPrincipalId) {
      continue;
    }
    items.push({
      kind:
        message.channel === "broadcast"
          ? "broadcast"
          : message.channel === "reported"
            ? "rumor"
            : "message",
      sourceId: message.fromId,
      text: message.text,
      worldTick: message.deliverAtTick,
    });
  }
  // 同一世界 tick 内保持通信日志的提交顺序，不按来源重排。
  return items.sort((left, right) => left.worldTick - right.worldTick);
}

/**
 * 笔记：玩家持有知识授权的证据，正文来自内容索引；秘密与其他知识不进入笔记。
 * 来源优先取证据条目声明的发现位置，没有位置时退化为授予途径（start/share/discovery/setup）。
 * 亲历事件摘要需要事件读取游标，当前端口不提供，因此不输出，也不伪造事件 ID 与摘要。
 */
function notebookEntries(
  content: GameContent,
  comms: GameCommsPort | undefined,
  playerPrincipalId: string,
): NotebookEntryView[] {
  if (comms === undefined) {
    return [];
  }
  const entries: NotebookEntryView[] = [];
  for (const knowledge of comms.knowledgeOf(playerPrincipalId)) {
    const evidence = content.evidence.get(knowledge.itemId);
    if (evidence === undefined) {
      continue;
    }
    entries.push({
      kind: "evidence",
      evidenceId: evidence.evidenceId,
      title: evidence.title,
      body: evidence.content,
      source: evidence.nodeId ?? knowledge.via,
    });
  }
  return entries.sort((left, right) => {
    if (left.kind !== "evidence" || right.kind !== "evidence") {
      return 0;
    }
    return left.evidenceId.localeCompare(right.evidenceId);
  });
}

/**
 * 待回复角色：玩家在会话里说完最后一句，且该角色仍有排队或进行中的 turn。
 * 只暴露「正在处理」，不含 turn 内容；宿主没提供调度状态时为空。
 */
function awaitingReplyFrom(input: {
  readonly content: GameContent;
  readonly comms: GameCommsPort | undefined;
  readonly playerPrincipalId: string;
  readonly awaitingReplyCharacters: readonly string[];
}): string[] {
  const { content, comms, playerPrincipalId, awaitingReplyCharacters } = input;
  if (comms === undefined || awaitingReplyCharacters.length === 0) {
    return [];
  }
  const pending = new Set(awaitingReplyCharacters);
  const waiting = new Set<string>();
  for (const conversationId of comms.conversationsOf(playerPrincipalId)) {
    const lines = comms.conversationMessages(conversationId, conversationLineLimit);
    const last = lines[lines.length - 1];
    if (last === undefined || last.speakerId !== playerPrincipalId) {
      continue;
    }
    for (const delivery of last.deliveries) {
      if (
        delivery.principalId !== playerPrincipalId &&
        pending.has(delivery.principalId) &&
        content.characters.has(delivery.principalId)
      ) {
        waiting.add(delivery.principalId);
      }
    }
  }
  return [...waiting].sort((left, right) => left.localeCompare(right));
}

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
function notificationViews(input: {
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

/** 构建完整玩家投影；缺少可选端口时对应集合为空，绝不伪造私有数据。 */
export function buildPlayerProjection(input: PlayerProjectionInput): PlayerProjection {
  const { content, clock, world, map } = input;
  const tick = clock.worldTick;
  const playerPrincipalId = input.playerPrincipalId ?? content.playerPrincipalId;
  const campaign = world.campaign();
  const nodeViews = [...content.nodes.values()].map((node) => ({
    nodeId: node.nodeId,
    name: node.name,
    x: node.x,
    y: node.y,
    facilities: [...node.facilities],
  }));
  const roadViews = [...content.roads.values()].map((road) => ({
    roadId: road.roadId,
    fromNodeId: road.a,
    toNodeId: road.b,
    travelTicks: road.travelTicks,
    risk: road.risk,
    status: map.roadStatus(road.roadId) ?? "open",
  }));
  const meterView = metersView(world);
  const delegations = world.delegationsOf(playerPrincipalId);
  const stockpiles = stockpileViews({
    content,
    resources: input.resources,
    delegations,
    tick,
  });
  const teams = teamViews({ world, delegations, tick });
  const characters = characterViews({ content, world, tick });
  const tasks = taskViews({ actions: input.actions, world, playerPrincipalId });
  const agreements = agreementViews(input.agreements, playerPrincipalId);
  const conversations = conversationLines({
    content,
    comms: input.comms,
    playerPrincipalId,
    playerName: input.playerName,
    tick,
  });
  const inbox = inboxItems(input.comms, playerPrincipalId);
  const notebook = notebookEntries(content, input.comms, playerPrincipalId);
  return playerProjectionSchema.parse({
    campaign: campaign === null
      ? null
      : {
          campaignId: campaign.campaignId,
          factionId: campaign.factionId,
          factionName: content.factions.get(campaign.factionId)?.name ?? campaign.factionId,
          commission: content.starts.get(campaign.factionId)?.commission ?? "第 7 日",
          status: campaign.status,
          outcome: campaign.outcome,
          startTick: campaign.startTick,
        },
    clock,
    map: { nodes: nodeViews, roads: roadViews },
    meters: meterView,
    stockpiles,
    teams,
    characters,
    tasks,
    agreements,
    // 首版规则只邀请 Agent 角色，玩家不会被邀请；字段保留给后续多席位邀请，当前恒为空。
    invitations: [],
    conversations,
    inbox,
    notebook,
    awaitingReplyFrom: awaitingReplyFrom({
      content,
      comms: input.comms,
      playerPrincipalId,
      awaitingReplyCharacters: input.awaitingReplyCharacters ?? [],
    }),
    notifications: notificationViews({
      agreements,
      owns: tasks.filter((task) => task.kind === "own"),
      meters: meterView,
      inbox,
      playerPrincipalId,
      tick,
    }),
  });
}
