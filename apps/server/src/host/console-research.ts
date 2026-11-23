/**
 * 核心职责：组合观测 provider、游戏只读端口与内容索引，构造控制台研究查询端口。
 * 交互契约：依赖宿主作用域事务、已装配模块端口与当前在线入口；不执行世界命令或模型调用。
 * 约束与禁忌：禁止越权读取玩家投影之外的秘密；原始证据查询必须由观测 provider 记录审计。
 */
/* eslint-disable no-unused-vars -- 接口方法参数名仅表达调用契约，运行时由实现使用位置参数。 */
import { createHash } from "node:crypto";
import {
  DomainError,
  agentLastKnownViewSchema,
  agentWorldViewSchema,
  canonicalJson,
  type AgentInspectorResponse,
  type AgentLastKnownView,
  type AgentWorldView,
  type ArtifactResponse,
  type Json,
  type TurnReplayResponse,
} from "@ai-npc/contracts";
import type { GameContent } from "@ai-npc/module-sdk";
import type { HostReadPorts } from "./reads";
import type { ServerRuntime } from "./module-catalog";

function emptyLastKnown(): AgentLastKnownView {
  return {
    relayStability: null,
    orchardWater: null,
    migrationSafety: null,
    watergateAllocation: null,
    roads: [],
    stockpiles: [],
  };
}

function worldIdOf(storage: ServerRuntime["storage"], branchId: string): string {
  const worldId = storage.transact((tx) => tx.rows("branches").get({ branch_id: branchId })?.["world_id"]);
  if (typeof worldId !== "string") throw new DomainError("not-found", `分支 ${branchId} 不存在`);
  return worldId;
}

function secretRedactor(content: GameContent): (value: Json) => Json {
  const replacements = [...content.secrets.values()].flatMap((secret) => {
    const text = secret.content;
    if (text.length === 0) return [];
    return [{ text, label: `[SECRET ${secret.secretId} len=${text.length}]` }];
  }).sort((left, right) => right.text.length - left.text.length);
  const replaceText = (text: string): string => {
    let result = text;
    for (const replacement of replacements) result = result.replaceAll(replacement.text, replacement.label);
    return result;
  };
  const redact = (value: Json): Json => {
    if (typeof value === "string") return replaceText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") {
      const entries: [string, Json][] = [];
      const keys = new Set<string>();
      for (const [key, nested] of Object.entries(value)) {
        const base = replaceText(key);
        let redactedKey = base;
        let suffix = 2;
        while (keys.has(redactedKey)) redactedKey = `${base}#${suffix++}`;
        keys.add(redactedKey);
        entries.push([redactedKey, redact(nested)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  return redact;
}

function personaOf(content: GameContent, agentId: string): Json {
  const character = content.characters.get(agentId);
  if (character !== undefined) {
    return {
      kind: "character",
      name: character.name,
      role: character.role,
      factionId: character.factionId,
      skills: [...character.skills],
      values: [...character.values],
    };
  }
  const faction = content.factions.get(agentId);
  if (faction === undefined) return { agentId };
  return {
    kind: "strategic",
    name: faction.name,
    factionId: faction.factionId,
    leaderName: faction.leaderName ?? null,
  };
}

export interface ConsoleResearchPort {
  readonly inspector: (input: {
    readonly agentId: string;
    readonly branchId: string;
  }) => AgentInspectorResponse;
  readonly memory: (input: {
    readonly agentId: string;
    readonly branchId: string;
    readonly revision: number;
  }) => ReturnType<ServerRuntime["observability"]["memory"]>;
  readonly memoryDiff: (input: {
    readonly agentId: string;
    readonly branchId: string;
    readonly fromRevision: number;
    readonly toRevision: number;
  }) => ReturnType<ServerRuntime["observability"]["memoryDiff"]>;
  readonly observations: (input: {
    readonly agentId: string;
    readonly branchId: string;
    readonly fromSeq: number;
    readonly limit: number;
  }) => ReturnType<ServerRuntime["observability"]["observations"]>;
  readonly turns: (query: {
    readonly runId?: string;
    readonly branchId?: string;
    readonly worldId?: string;
    readonly agentId?: string;
    readonly status?: string;
    readonly limit?: number;
  }) => ReturnType<ServerRuntime["observability"]["turns"]>;
  readonly turn: (input: {
    readonly turnId: string;
  }) => ReturnType<ServerRuntime["observability"]["turn"]>;
  readonly artifact: (input: {
    readonly artifactId: string;
    readonly view: "redacted" | "raw";
    readonly principalId: string;
  }) => ArtifactResponse;
  readonly trace: (input: {
    readonly traceId: string;
  }) => ReturnType<ServerRuntime["observability"]["trace"]>;
  readonly branchCompare: (input: {
    readonly leftBranchId: string;
    readonly rightBranchId: string;
    readonly atSeq: number;
  }) => ReturnType<ServerRuntime["observability"]["branchCompare"]>;
  readonly debugQueues: (input: {
    readonly branchId: string;
  }) => ReturnType<ServerRuntime["observability"]["debugQueues"]>;
  readonly replayTurn: (input: {
    readonly turnId: string;
  }) => Promise<TurnReplayResponse>;
  readonly debugWake: (input: {
    readonly agentId: string;
    readonly reason: string;
    readonly operationId: string;
    readonly branchId: string;
  }) => ReturnType<ServerRuntime["observability"]["debugWake"]>;
}

export function createConsoleResearchPort(input: {
  readonly runtime: ServerRuntime;
  readonly reads: HostReadPorts;
  readonly currentWorldId: () => string;
  readonly content: GameContent;
}): ConsoleResearchPort {
  const { runtime, reads, currentWorldId, content } = input;
  const redact = secretRedactor(content);
  const assertBranchScope = (branchId: string): void => {
    if (worldIdOf(runtime.storage, branchId) !== currentWorldId()) {
      throw new DomainError("forbidden", `分支 ${branchId} 不属于当前世界`);
    }
  };
  const assertArtifactScope = (artifactId: string): void => {
    const runId = runtime.storage.transact((tx) =>
      tx.rows("artifacts").get({ artifact_id: artifactId })?.["run_id"]);
    if (runId === undefined) throw new DomainError("not-found", `artifact ${artifactId} 不存在`);
    if (runId === null) return;
    if (typeof runId !== "string") throw new DomainError("invalid-state", `artifact ${artifactId} 的 run_id 不合法`);
    const branchId = runtime.storage.transact((tx) =>
      tx.rows("runs").get({ run_id: runId })?.["branch_id"]);
    if (typeof branchId !== "string") throw new DomainError("forbidden", `artifact ${artifactId} 缺少可访问 run`);
    assertBranchScope(branchId);
  };

  const inspector = (input: {
    readonly agentId: string;
    readonly branchId: string;
  }): AgentInspectorResponse => {
    const { agentId, branchId } = input;
    assertBranchScope(branchId);
    const worldId = worldIdOf(runtime.storage, branchId);
    const scope = { branchId, worldId };
    const snapshot = runtime.storage.transact((tx) => {
      const ports = reads.portsIn(tx, scope);
      const world = ports["game.world"];
      const resources = ports["game.resources"];
      const comms = ports["game.comms"];
      const agreements = ports["game.agreements"];
      const tick = runtime.clock.readInTransaction(tx, branchId).worldTick;
      const character = world.character(agentId);
      const staticFaction = content.factions.get(agentId);
      const characterContent = content.characters.get(agentId);
      const factionId = character?.factionId ?? staticFaction?.factionId ?? characterContent?.factionId ?? agentId;
      const nodeId = character?.nodeId ?? staticFaction?.factionHomeNodeId ??
        staticFaction?.territoryNodeId ?? characterContent?.spawnNodeId ?? null;
      const perception = tx.branch(branchId).table("perception_state").get({ agent_id: agentId });
      const state = perception?.["state_json"];
      const lastKnownCandidate = state !== null && !Array.isArray(state) && typeof state === "object"
        && !(state instanceof Uint8Array)
        ? state["lastKnown"] : null;
      const parsedLastKnown = agentLastKnownViewSchema.safeParse(lastKnownCandidate);
      const knownItemIds = new Set(comms.knowledgeOf(agentId)
        .filter(({ grantedAtTick }) => grantedAtTick <= tick)
        .map(({ itemId }) => itemId));
      const factionCharacters = [...content.characters.values()]
        .filter((entry) => entry.factionId === factionId)
        .map(({ agentId: id }) => id);
      const factionStockpiles = [...content.stockpiles.values()]
        .filter((entry) => entry.ownerFactionId === factionId)
        .flatMap((entry) => {
          const stockpile = resources.stockpile(entry.stockpileId);
          return stockpile === null ? [] : [{
            stockpileId: entry.stockpileId,
            amounts: { ...stockpile.amount },
            asOfTick: tick,
          }];
        });
      const factionTeams = [...content.teams.values()]
        .filter((entry) => entry.ownerFactionId === factionId)
        .flatMap((entry) => {
          const team = world.team(entry.teamId);
          return team === null ? [] : [{ teamId: entry.teamId, status: team.status, asOfTick: tick }];
        });
      const delegations = world.delegationsOf(agentId).flatMap((delegation) => {
        const initial = content.dutyDelegations.find((candidate) =>
          candidate.grantorFactionId === delegation.grantorFactionId &&
          candidate.teamIds.some((teamId) => delegation.teamIds.includes(teamId)));
        if (initial === undefined) return [];
        return [{
          delegationId: delegation.delegationId,
          grantorFactionId: delegation.grantorFactionId,
          teamIds: [...delegation.teamIds],
          stockpileId: delegation.stockpileId,
          maxDraw: { ...initial.maxDraw },
          remaining: { ...delegation.remaining },
          untilTick: delegation.untilTick,
        }];
      });
      const ownAgreements = agreements.agreementsOf(agentId);
      const worldView: AgentWorldView = agentWorldViewSchema.parse({
        self: {
          agentId,
          kind: staticFaction === undefined ? "character" : "strategic",
          nodeId,
          injured: (character?.injuredUntilTick ?? 0) > tick,
          injuredUntilTick: character?.injuredUntilTick ?? null,
          currentTaskId: character?.currentTaskId ?? null,
          delegations,
          invitations: [],
          agreements: ownAgreements,
          recentAgreements: ownAgreements,
        },
        staticMap: {
          nodes: [...content.nodes.values()].map((node) => ({
            nodeId: node.nodeId,
            name: node.name,
            x: node.x,
            y: node.y,
            facilities: [...node.facilities],
          })),
          roads: [...content.roads.values()].map((road) => ({
            roadId: road.roadId,
            fromNodeId: road.a,
            toNodeId: road.b,
            travelTicks: road.travelTicks,
            risk: road.risk,
          })),
        },
        lastKnown: parsedLastKnown.success ? parsedLastKnown.data : emptyLastKnown(),
        faction: {
          factionId,
          strategicAgentId: content.factions.has(factionId) ? factionId : agentId,
          characterIds: factionCharacters,
          stockpiles: factionStockpiles,
          teams: factionTeams,
        },
        evidence: [...content.evidence.values()].flatMap((evidence) =>
          knownItemIds.has(evidence.evidenceId) ? [{
            evidenceId: evidence.evidenceId,
            title: evidence.title,
            body: evidence.content,
          }] : []),
        secrets: [...content.secrets.values()].flatMap((secret) =>
          knownItemIds.has(secret.secretId) ? [{
            secretId: secret.secretId,
            body: secret.content,
            shareable: false,
          }] : []),
      });
      return {
        location: nodeId,
        worldView,
      };
    });
    return runtime.observability.inspector({
      branchId,
      agentId,
      persona: personaOf(content, agentId),
      location: snapshot.location,
      worldView: snapshot.worldView,
    });
  };

  const artifact = (input: {
    readonly artifactId: string;
    readonly view: "redacted" | "raw";
    readonly principalId: string;
  }): ArtifactResponse => {
    const { artifactId, view, principalId } = input;
    assertArtifactScope(artifactId);
    const raw = runtime.observability.artifact(artifactId, view, principalId);
    if (view === "raw") return raw;
    let parsed: Json;
    try {
      parsed = JSON.parse(raw.body) as Json;
    } catch {
      throw new DomainError("invalid-state", `artifact ${artifactId} 的正文不是 JSON`);
    }
    return { ...raw, body: canonicalJson(redact(parsed)) };
  };

  const replayTurn = (input: { readonly turnId: string }): Promise<TurnReplayResponse> => {
    const { turnId } = input;
    const branch = runtime.storage.transact((tx) =>
      tx.rows("turn_runs").get({ turn_id: turnId })?.["branch_id"]);
    if (typeof branch !== "string") throw new DomainError("not-found", `turn ${turnId} 不存在`);
    assertBranchScope(branch);
    const attempts = runtime.storage.transact((tx) =>
      tx.rows("model_attempts").list({ work_ref: turnId }));
    if (attempts.length === 0) {
      return Promise.resolve({
        requestHashMatch: false,
        differences: [{ path: "attempts", expected: "至少一次归档模型请求", actual: [] }],
      });
    }
    const differences: TurnReplayResponse["differences"][number][] = [];
    for (const attempt of attempts) {
      if (typeof attempt["request_artifact_id"] !== "string") {
        differences.push({
          path: String(attempt["attempt_id"]),
          expected: "request_artifact_id",
          actual: null,
        });
        continue;
      }
      const artifactId = attempt["request_artifact_id"];
      const row = runtime.storage.transact((tx) => tx.rows("artifacts").get({ artifact_id: artifactId }));
      if (row === null) {
        differences.push({ path: artifactId, expected: "artifact", actual: null });
        continue;
      }
      const body = row["body"];
      if (!(body instanceof Uint8Array)) {
        differences.push({ path: artifactId, expected: "inline artifact", actual: "unsupported storage" });
        continue;
      }
      const text = new TextDecoder().decode(body);
      let parsed: Json;
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        differences.push({ path: artifactId, expected: "valid JSON", actual: null });
        continue;
      }
      let canonical: string;
      try {
        canonical = canonicalJson(parsed);
      } catch {
        differences.push({ path: artifactId, expected: "canonical JSON", actual: null });
        continue;
      }
      const actualHash = createHash("sha256").update(canonical).digest("hex");
      const expectedHash = String(row["content_hash"]);
      if (actualHash !== expectedHash) {
        differences.push({ path: artifactId, expected: expectedHash, actual: actualHash });
      }
    }
    return Promise.resolve({ requestHashMatch: differences.length === 0, differences });
  };

  return {
    inspector,
    memory: ({ agentId, branchId, revision }) => {
      assertBranchScope(branchId);
      return runtime.observability.memory(branchId, agentId, revision);
    },
    memoryDiff: ({ agentId, branchId, fromRevision, toRevision }) => {
      assertBranchScope(branchId);
      return runtime.observability.memoryDiff(branchId, agentId, fromRevision, toRevision);
    },
    observations: ({ agentId, branchId, fromSeq, limit }) => {
      assertBranchScope(branchId);
      return runtime.observability.observations(branchId, agentId, fromSeq, limit);
    },
    turns: (query) => {
      const worldId = currentWorldId();
      if (query.branchId !== undefined) {
        assertBranchScope(query.branchId);
        return runtime.observability.turns({ ...query, worldId });
      }
      const runId = query.runId;
      if (runId !== undefined) {
        const runWorld = runtime.storage.transact((tx) =>
          tx.rows("runs").get({ run_id: runId })?.["world_id"]);
        if (runWorld !== worldId) throw new DomainError("forbidden", "run 不属于当前世界");
      }
      return runtime.observability.turns({ ...query, worldId });
    },
    turn: ({ turnId }) => {
      const branch = runtime.storage.transact((tx) =>
        tx.rows("turn_runs").get({ turn_id: turnId })?.["branch_id"]);
      if (typeof branch !== "string") throw new DomainError("not-found", `turn ${turnId} 不存在`);
      assertBranchScope(branch);
      return runtime.observability.turn(turnId);
    },
    artifact,
    trace: ({ traceId }) => {
      const branch = runtime.storage.transact((tx) =>
        tx.all("SELECT branch_id FROM trace_spans WHERE trace_id = ? AND branch_id IS NOT NULL LIMIT 1", [traceId])[0]?.["branch_id"]);
      if (typeof branch !== "string") throw new DomainError("not-found", `trace ${traceId} 不存在`);
      assertBranchScope(branch);
      return runtime.observability.trace(traceId);
    },
    branchCompare: ({ leftBranchId, rightBranchId, atSeq }) => {
      assertBranchScope(leftBranchId);
      assertBranchScope(rightBranchId);
      return runtime.observability.branchCompare(leftBranchId, rightBranchId, atSeq);
    },
    debugQueues: ({ branchId }) => {
      assertBranchScope(branchId);
      return runtime.observability.debugQueues(branchId);
    },
    replayTurn,
    debugWake: ({ agentId, reason, operationId, branchId }) => {
      assertBranchScope(branchId);
      return runtime.observability.debugWake(branchId, agentId, reason, operationId);
    },
  };
}
