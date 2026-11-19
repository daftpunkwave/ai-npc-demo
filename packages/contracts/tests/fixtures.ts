/**
 * 契约测试共享的固定样例工厂。
 * 依赖公共契约包的投影、记忆、命令回执与装配类型；仅被测试文件导入。
 * 禁止在此访问网络、文件系统或真实世界状态；每个工厂都返回新的普通对象。
 */
import type {
  AgentObservation,
  AgentWorldView,
  CommandReceipt,
  InputFrontier,
  MemoryRecord,
  MemoryScope,
  PlayerProjection,
  ResolvedModuleSet,
  TurnDetail,
  TurnSummary,
} from "../src/index";

/** 模块引用样例。 */
export function moduleRefFixture(): ResolvedModuleSet["modules"][number] {
  return {
    moduleId: "client.hud.standard",
    version: "1.0.0",
    apiVersion: "1",
    configHash: "config-hash",
  };
}

/** 能力引用样例。 */
export function capabilityRefFixture(): ResolvedModuleSet["capabilities"][number] {
  return { capability: "client.hud", cardinality: "exactly-one", instanceScope: "deployment" };
}

/** 已解析模块集样例，realm 由调用方指定。 */
export function resolvedModuleSetFixture(realm: "server" | "client" | "console" = "server"): ResolvedModuleSet {
  return {
    realm,
    protocolVersion: "1",
    modules: [moduleRefFixture()],
    capabilities: [capabilityRefFixture()],
    assemblyHash: "assembly-hash",
  };
}

/** 记忆作用域样例。 */
export function memoryScopeFixture(): MemoryScope {
  return {
    worldId: "wld-k3j9x0a1b2c3",
    branchId: "br-k3j9x0a1b2c3",
    agentId: "npc-cenyan",
  };
}

/** 输入边界样例。 */
export function inputFrontierFixture(): InputFrontier {
  return {
    worldSeq: 20,
    worldTick: 5,
    observationSeq: 12,
    perceptionRevision: 4,
    memoryRevision: 7,
    conversationCursor: null,
    knowledgeGrantRevision: 2,
  };
}

/** 观察记录样例。 */
export function observationFixture(): AgentObservation {
  return {
    observationId: "obs-k3j9x0a1b2c3",
    scope: memoryScopeFixture(),
    observationSeq: 3,
    sourceEventIds: ["evt-k3j9x0a1b2c3"],
    sourceObservationIds: [],
    occurredAtTick: 2,
    sensedAtTick: 3,
    knownAtTick: 4,
    channel: "relay",
    epistemic: "witnessed",
    confidence: 0.6,
    releasePolicyId: "public",
    content: { summaryZh: "岑雁说：小心。", detail: "full" },
  };
}

/** 记忆记录样例。 */
export function memoryRecordFixture(): MemoryRecord {
  return {
    memoryId: "mem-k3j9x0a1b2c3",
    scope: memoryScopeFixture(),
    kind: "episodic",
    sourceObservationIds: ["obs-k3j9x0a1b2c3"],
    contentRefs: [{ contentId: "ev-flood-log", contentVersion: "1" }],
    status: "active",
    epistemic: "verified-event",
    releasePolicyId: "public",
    validFromTick: 2,
    validUntilTick: 48,
    revision: 3,
    content: { summaryZh: "任务完成" },
  };
}

/** 命令回执样例。 */
export function commandReceiptFixture(): CommandReceipt {
  return {
    receiptId: "rcp-k3j9x0a1b2c3",
    commandId: "cmd-k3j9x0a1b2c3",
    commandStatus: "accepted",
    reasonCode: null,
    safeMessage: null,
    acceptedEventIds: ["evt-k3j9x0a1b2c3"],
    operationId: "op-k3j9x0a1b2c3",
    resultingVersions: { "campaign:cmp-k3j9x0a1b2c3": 1 },
    result: null,
    worldTick: 0,
  };
}

/** 协议视图样例。 */
export function agreementViewFixture() {
  return {
    agreementId: "agr-k3j9x0a1b2c3",
    version: 1,
    proposerId: "player-1",
    parties: ["player-1", "human-neutral"],
    terms: [
      {
        term: { kind: "escort", obligorId: "player-1", roadId: "r-gh-ps", byTick: 48 },
        status: "open",
        progress: null,
      },
    ],
    status: "proposed",
    expiresAtTick: 24,
    supersedesId: null,
  };
}

/** 任务邀请视图样例。 */
export function invitationViewFixture() {
  return {
    invitationId: "inv-k3j9x0a1b2c3",
    taskId: "task-k3j9x0a1b2c3",
    inviteeId: "player-1",
    taskType: "transport",
    departTick: 2,
    response: null,
  };
}

/** 玩家投影样例。 */
export function playerProjectionFixture(): PlayerProjection {
  return {
    campaign: {
      campaignId: "cmp-k3j9x0a1b2c3",
      factionId: "human-neutral",
      factionName: "灰港公社",
      commission: "整理物资与消息。",
      status: "running",
      outcome: null,
      startTick: 0,
    },
    clock: { worldTick: 0, day: 1, hour: 0, mode: "paused", runVersion: 0 },
    map: {
      nodes: [{ nodeId: "grayharbor", name: "灰港中继站", x: 12, y: 12, facilities: ["relay"] }],
      roads: [
        {
          roadId: "r-gh-or",
          fromNodeId: "grayharbor",
          toNodeId: "orchard",
          travelTicks: 5,
          risk: 0,
          status: "open",
        },
      ],
    },
    meters: {
      relayStability: { value: 45, level: "stable" },
      orchardWater: { value: 50, level: "stable" },
      migrationSafety: { value: 50, level: "stable" },
      watergateAllocation: "harbor-first",
    },
    stockpiles: [
      {
        stockpileId: "sp-commons",
        nodeId: "grayharbor",
        ownerFactionId: "human-neutral",
        supplyLevel: "adequate",
        energyLevel: "adequate",
        medicalLevel: "adequate",
        amounts: { supply: 60, energy: 12, medical: 8 },
        delegation: { remaining: { supply: 15, energy: 6, medical: 4 }, untilTick: 168 },
      },
    ],
    teams: [
      {
        teamId: "team-commons",
        nodeId: "grayharbor",
        ownerFactionId: "human-neutral",
        status: "idle",
        delegatedToMe: true,
      },
    ],
    characters: [
      {
        agentId: "npc-wenyuan",
        name: "温原",
        factionId: "human-neutral",
        role: "物资官",
        nodeId: "grayharbor",
        injured: false,
        injuredUntilTick: null,
        publicClaim: "公平透明",
      },
    ],
    tasks: [
      {
        kind: "own",
        taskId: "task-k3j9x0a1b2c3",
        taskType: "transport",
        teamId: "team-commons",
        participants: ["npc-wenyuan"],
        params: {
          fromStockpileId: "sp-commons",
          toStockpileId: "sp-earth",
          cargo: { supply: 10, energy: 0, medical: 0 },
        },
        commandStatus: "accepted",
        taskStatus: "pending",
        departTick: 1,
        nominalCompletionTick: 7,
        delayNoticeSent: false,
        route: null,
      },
    ],
    agreements: [agreementViewFixture()],
    invitations: [invitationViewFixture()],
    conversations: [
      {
        seq: 0,
        dialogueId: "dlg-k3j9x0a1b2c3",
        speakerId: "npc-cenyan",
        speakerName: "岑雁",
        text: "你好",
        worldTick: 0,
        channel: "face-to-face",
      },
    ],
    inbox: [{ kind: "message", sourceId: "npc-wenyuan", text: "仓里的供给每天都在少。", worldTick: 0 }],
    notebook: [
      {
        kind: "evidence",
        evidenceId: "ev-flood-log",
        title: "运输队延误记录",
        body: "补给车队因旧堤渗水改道。",
        source: "archive",
      },
    ],
    awaitingReplyFrom: ["npc-cenyan"],
    notifications: [{ kind: "urgent", text: "有新的委托", worldTick: 0 }],
  };
}

/** Agent 世界视图样例。 */
export function agentWorldViewFixture(): AgentWorldView {
  return {
    self: {
      agentId: "npc-cenyan",
      kind: "character",
      nodeId: "pass",
      injured: false,
      injuredUntilTick: null,
      currentTaskId: null,
      delegations: [
        {
          delegationId: "del-k3j9x0a1b2c3",
          grantorFactionId: "human-independent",
          teamIds: ["team-rubble"],
          stockpileId: "sp-rubble",
          maxDraw: { supply: 10, energy: 4, medical: 2 },
          remaining: { supply: 10, energy: 4, medical: 2 },
          untilTick: 168,
        },
      ],
      invitations: [],
      agreements: [],
      recentAgreements: [agreementViewFixture()],
    },
    staticMap: {
      nodes: [{ nodeId: "pass", name: "迁徙隘口", x: 4, y: 8, facilities: ["outpost"] }],
      roads: [{ roadId: "r-gh-ps", fromNodeId: "grayharbor", toNodeId: "pass", travelTicks: 6, risk: 1 }],
    },
    lastKnown: {
      relayStability: { value: 45, asOfTick: 0 },
      orchardWater: null,
      migrationSafety: null,
      watergateAllocation: { value: "harbor-first", asOfTick: 0 },
      roads: [{ roadId: "r-gh-ps", status: "open", asOfTick: 0 }],
      stockpiles: [
        {
          stockpileId: "sp-rubble",
          supplyLevel: "stable",
          energyLevel: "stable",
          medicalLevel: "stable",
          asOfTick: 0,
        },
      ],
    },
    faction: {
      factionId: "human-independent",
      strategicAgentId: "human-independent",
      characterIds: ["npc-cenyan"],
      stockpiles: [
        {
          stockpileId: "sp-rubble",
          amounts: { supply: 30, energy: 10, medical: 4 },
          asOfTick: 0,
        },
      ],
      teams: [{ teamId: "team-rubble", status: "idle", asOfTick: 0 }],
    },
    evidence: [{ evidenceId: "ev-flood-log", title: "运输队延误记录", body: "补给车队改道。" }],
    secrets: [{ secretId: "sec-fauna-ridge-route", body: "备用路线走山脊道。", shareable: false }],
  };
}

/** turn 摘要样例。 */
export function turnSummaryFixture(): TurnSummary {
  return {
    turnId: "turn-k3j9x0a1b2c3",
    runId: "run-k3j9x0a1b2c3",
    branchId: "br-k3j9x0a1b2c3",
    agentId: "npc-cenyan",
    agentTurnIndex: 0,
    status: "completed",
    triggerKinds: ["player-dialogue"],
    terminalReason: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    endedAt: "2026-11-18T00:00:05.000Z",
    modelCalls: 1,
    toolCalls: 0,
    tokens: { input: 1200, output: 120 },
  };
}

/** turn 详情样例。 */
export function turnDetailFixture(): TurnDetail {
  return {
    ...turnSummaryFixture(),
    inputFrontier: inputFrontierFixture(),
    memoryRevision: 7,
    stages: [
      {
        stage: "context",
        status: "applied",
        reason: null,
        requested: { segments: 4 },
        resolved: { segments: 4 },
        effective: { segments: 4 },
        spanId: "spn-k3j9x0a1b2c3",
      },
    ],
    contextArtifactIds: ["art-k3j9x0a1b2c3"],
    attempts: [
      {
        attemptId: "att-k3j9x0a1b2c3",
        purpose: "decision",
        modelId: "npc-chat",
        status: "completed",
        isEffective: true,
        requestArtifactId: "art-k3j9x0a1b2c3",
        responseArtifactId: "art-k3j9x0a1b2c4",
        usage: { inputTokens: 1200, outputTokens: 120 },
        error: null,
      },
    ],
    toolCalls: [],
    decision: { stance: "accept" },
    speech: { speechArtifactId: "art-k3j9x0a1b2c5", text: "我会处理。", fallback: false },
    traceId: "trc-k3j9x0a1b2c3",
  };
}
