/**
 * 按规则第 6 节的十步顺序校验 task.dispatch，并计算路线、资源预留、邀请与完成 tick。
 * 依赖内容视图、地图/资源/世界端口、公共任务参数与 authority 上下文。
 * 禁止在这里写任务聚合、扣资源或发事件；禁止把队伍状态、权限或受邀者可用性判断提前到参数校验之前。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将模块端口泛型误判为 any。 */
import type { ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
import {
  addAmounts,
  coversAmounts,
  effectivePrincipalId,
  requireGameContent,
  subtractAmounts,
  totalAmount,
  zeroResources,
  type DrawAuthority,
  type GameContent,
  type GameModulePorts,
  type HandlerContext,
} from "@ai-npc/module-sdk";
import { hasFactionSupporter, transportCapacitySupporterAgentId } from "./faction-bonus";
import type { DispatchInput } from "./plan-types";
import { computeTaskRoute } from "./routes";

export type { DispatchInput } from "./plan-types";

/** team-star 修复只需能源 10，供给库存点可为 null。 */
const energyOnlyRepairTeamId = "team-star";

export interface DispatchPlan {
  readonly taskType: DispatchInput["taskType"];
  readonly teamId: string;
  readonly invitees: readonly string[];
  readonly params: Record<string, unknown>;
  readonly route: readonly string[];
  readonly departTick: number;
  readonly nominalCompletionTick: number;
  readonly phase: "pending";
  readonly reserved: ResourceAmounts;
  readonly stockpiles: readonly { readonly stockpileId: string; readonly amount: ResourceAmounts }[];
  readonly fromStockpileId: string | null;
  readonly toStockpileId: string | null;
  readonly patrolStartTick: number | null;
  readonly patrolEndTick: number | null;
  readonly workStartTick: number | null;
  readonly workNodeId: string | null;
}

export type PlanResult = { readonly ok: true; readonly plan: DispatchPlan } | PlanFailure;

type PlanFailure = { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

type StageResult<T> = { readonly ok: true; readonly value: T } | PlanFailure;

type DispatchContext = HandlerContext<GameModulePorts, unknown>;

type Reservation = { stockpileId: string; amount: ResourceAmounts };

/**
 * 第一阶段解析结果：任务类型专属的库存点、预留与受邀者可就位节点。
 * 后续阶段只读取这里的结果，不再重复解析 payload。
 */
interface ResolvedParams {
  readonly invitees: readonly string[];
  readonly departTick: number;
  readonly fromStockpileId: string | null;
  readonly toStockpileId: string | null;
  readonly stockpiles: readonly Reservation[];
  /** 受邀者可以就位的地点：队伍所在节点与该任务的工作节点。 */
  readonly participantNodes: readonly string[];
  /** 运输起点节点；其他任务类型为 null。 */
  readonly originNodeId: string | null;
  /** 运输货物总量；其他任务类型为 null。 */
  readonly cargoTotal: number | null;
}

function fail(reasonCode: ReasonCode, safeMessage: string): PlanFailure {
  return { ok: false, reasonCode, safeMessage };
}

function addReservation(reservations: Reservation[], stockpileId: string, amount: ResourceAmounts): void {
  const existing = reservations.find((entry) => entry.stockpileId === stockpileId);
  if (existing === undefined) {
    reservations.push({ stockpileId, amount });
  } else {
    existing.amount = addAmounts(existing.amount, amount);
  }
}

/**
 * 第一阶段：按任务类型解析并校验参数，遇到第一个不满足即返回 invalid-params。
 * 这里只用内容索引与队伍/群体/库存点的存在性判断，不判断队伍状态、权限或受邀者可用性。
 */
function resolveParams(
  content: GameContent,
  ports: GameModulePorts,
  input: DispatchInput,
  teamNodeId: string,
  atTick: number,
): StageResult<ResolvedParams> {
  const departAfter = input.departAfterTicks ?? ((input.invitees ?? []).length > 0 ? 2 : 1);
  if (!Number.isSafeInteger(departAfter) || departAfter < 1 || departAfter > 6) {
    return fail("invalid-params", "出发延迟必须在 1–6 tick");
  }
  const invitees = [...new Set(input.invitees ?? [])];
  for (const inviteeId of invitees) {
    if (!content.characters.has(inviteeId)) {
      return fail("invalid-params", "受邀角色不存在");
    }
  }
  const departTick = atTick + departAfter;

  switch (input.taskType) {
    case "transport": {
      const params = input.params as {
        readonly fromStockpileId: string;
        readonly toStockpileId: string;
        readonly cargo: ResourceAmounts;
      };
      const from = content.stockpiles.get(params.fromStockpileId);
      const to = content.stockpiles.get(params.toStockpileId);
      if (from === undefined || to === undefined) {
        return fail("invalid-params", "库存点不存在");
      }
      const cargoTotal = totalAmount(params.cargo);
      if (cargoTotal === 0) {
        return fail("invalid-params", "运输货物不能全为零");
      }
      return {
        ok: true,
        value: {
          invitees,
          departTick,
          fromStockpileId: from.stockpileId,
          toStockpileId: to.stockpileId,
          stockpiles: [{ stockpileId: from.stockpileId, amount: params.cargo }],
          participantNodes: [teamNodeId, from.nodeId],
          originNodeId: from.nodeId,
          cargoTotal,
        },
      };
    }
    case "escort": {
      const params = input.params as { readonly roadId: string; readonly durationTicks?: number };
      const road = content.roads.get(params.roadId);
      if (road === undefined) {
        return fail("invalid-params", "道路不存在");
      }
      if (params.durationTicks !== undefined && (params.durationTicks < 6 || params.durationTicks > 24)) {
        return fail("invalid-params", "护送时长必须在 6–24 tick");
      }
      return {
        ok: true,
        value: {
          invitees,
          departTick,
          fromStockpileId: null,
          toStockpileId: null,
          stockpiles: [],
          participantNodes: [teamNodeId, road.a, road.b],
          originNodeId: null,
          cargoTotal: null,
        },
      };
    }
    case "rescue": {
      const params = input.params as {
        readonly groupId: string;
        readonly toNodeId: string;
        readonly medicalStockpileId: string;
      };
      const group = content.groups.get(params.groupId);
      const medical = content.stockpiles.get(params.medicalStockpileId);
      if (group === undefined || medical === undefined || medical.nodeId !== params.toNodeId) {
        return fail("invalid-params", "救援群体或医疗库存点不合法");
      }
      if (ports["game.world"].group(params.groupId)?.status === "rescued") {
        return fail("invalid-params", "群体已经被救出");
      }
      const targetNode = content.nodes.get(params.toNodeId);
      if (
        targetNode === undefined ||
        !targetNode.facilities.some((facility) => content.medicalFacilities.includes(facility))
      ) {
        return fail("invalid-params", "救援目标没有医疗设施");
      }
      return {
        ok: true,
        value: {
          invitees,
          departTick,
          fromStockpileId: medical.stockpileId,
          toStockpileId: medical.stockpileId,
          stockpiles: [{ stockpileId: medical.stockpileId, amount: { supply: 0, energy: 0, medical: group.injured } }],
          participantNodes: [teamNodeId, group.nodeId, params.toNodeId],
          originNodeId: null,
          cargoTotal: null,
        },
      };
    }
    case "repair": {
      const params = input.params as {
        readonly energyStockpileId: string;
        readonly supplyStockpileId: string | null;
      };
      const energy = content.stockpiles.get(params.energyStockpileId);
      if (energy === undefined) {
        return fail("invalid-params", "能源库存点不存在");
      }
      const supply =
        params.supplyStockpileId === null ? undefined : content.stockpiles.get(params.supplyStockpileId);
      if (params.supplyStockpileId !== null && supply === undefined) {
        return fail("invalid-params", "供给库存点不存在");
      }
      const energyOnly = input.teamId === energyOnlyRepairTeamId;
      if (!energyOnly && params.supplyStockpileId === null) {
        return fail("invalid-params", "修复任务必须提供供给库存点");
      }
      if (energy.nodeId !== "grayharbor" && energy.nodeId !== teamNodeId) {
        return fail("invalid-params", "能源库存点不在工作节点");
      }
      if (supply !== undefined && supply.nodeId !== "grayharbor" && supply.nodeId !== teamNodeId) {
        return fail("invalid-params", "供给库存点不在工作节点");
      }
      const stockpiles: Reservation[] = [{ stockpileId: energy.stockpileId, amount: { supply: 0, energy: 10, medical: 0 } }];
      if (!energyOnly && supply !== undefined) {
        addReservation(stockpiles, supply.stockpileId, { supply: 5, energy: 0, medical: 0 });
      }
      return {
        ok: true,
        value: {
          invitees,
          departTick,
          fromStockpileId: energy.stockpileId,
          toStockpileId: supply?.stockpileId ?? null,
          stockpiles,
          participantNodes: [teamNodeId, "grayharbor"],
          originNodeId: null,
          cargoTotal: null,
        },
      };
    }
    case "scout": {
      const params = input.params as { readonly nodeId: string };
      if (!content.nodes.has(params.nodeId)) {
        return fail("invalid-params", "侦察节点不存在");
      }
      return {
        ok: true,
        value: {
          invitees,
          departTick,
          fromStockpileId: null,
          toStockpileId: null,
          stockpiles: [],
          participantNodes: [teamNodeId, params.nodeId],
          originNodeId: null,
          cargoTotal: null,
        },
      };
    }
    default:
      return fail("invalid-params", "任务类型不存在");
  }
}

/** 校验并计算一次派遣；任何失败都不写状态。 */
export function planDispatch(context: DispatchContext, input: DispatchInput): PlanResult {
  const content = requireGameContent(context.content);
  const ports = context.modules;
  const dispatcher = effectivePrincipalId(context.auth);
  const team = content.teams.get(input.teamId);
  const teamView = ports["game.world"].team(input.teamId);

  // 第 1 步 invalid-params：队伍存在性、参数解析与格式；不得在此返回后续阶段的原因码。
  if (team === undefined) {
    return fail("invalid-params", "队伍不存在");
  }
  if (teamView === null) {
    return fail("invalid-params", "队伍状态不存在");
  }
  const paramsResult = resolveParams(content, ports, input, teamView.nodeId, context.tx.worldTick);
  if (!paramsResult.ok) {
    return paramsResult;
  }
  const resolved = paramsResult.value;

  // 第 2 步 no-authority：队伍派遣权与将用到的每个库存点的动用权。
  if (!ports["game.world"].canDispatchTeam(dispatcher, input.teamId)) {
    return fail("no-authority", "派遣者没有该队伍的有效授权");
  }
  const authorities = new Map<string, DrawAuthority>();
  for (const stockpile of resolved.stockpiles) {
    const authority = ports["game.world"].drawAuthority(dispatcher, stockpile.stockpileId);
    if (authority.kind === "none" && !context.auth.roles.includes("system")) {
      return fail("no-authority", "没有该库存点的动用权");
    }
    authorities.set(stockpile.stockpileId, authority);
  }

  // 第 3 步 team-busy。
  if (teamView.status !== "idle") {
    return fail("team-busy", "队伍正在执行其他任务");
  }

  // 第 4 步 capability-missing。
  if (!teamView.capabilities.includes(input.taskType)) {
    return fail("capability-missing", "队伍缺少该任务能力");
  }

  // 第 5 步 team-not-at-origin（仅运输）。
  if (resolved.originNodeId !== null && teamView.nodeId !== resolved.originNodeId) {
    return fail("team-not-at-origin", "队伍不在运输起点");
  }

  // 第 6 步 over-capacity（仅运输，受邀者中有本派物资支持者时运力 +5）。
  if (resolved.cargoTotal !== null) {
    const capacity =
      teamView.capacity +
      (hasFactionSupporter(content, team.ownerFactionId, resolved.invitees, transportCapacitySupporterAgentId)
        ? 5
        : 0);
    if (resolved.cargoTotal > capacity) {
      return fail("over-capacity", "货物超过队伍运力");
    }
  }

  // 第 7 步 participant-unavailable：受伤、正忙或不在队伍节点与该任务工作节点。
  for (const inviteeId of resolved.invitees) {
    const character = ports["game.world"].character(inviteeId);
    if (
      character === null ||
      character.currentTaskId !== null ||
      (character.injuredUntilTick !== null && character.injuredUntilTick > context.tx.worldTick) ||
      !resolved.participantNodes.includes(character.nodeId)
    ) {
      return fail("participant-unavailable", "受邀角色当前不可参与该任务");
    }
  }

  // 第 8 步 route-unavailable。
  const route = computeTaskRoute(
    ports,
    content,
    input,
    teamView.nodeId,
    team.ownerFactionId,
    resolved.departTick,
    resolved.invitees,
  );
  if (route === null) {
    return fail("route-unavailable", "找不到可用路线");
  }

  // 第 9 步 draw-limit-exceeded：按委托身份动用时不超过委托余额。
  for (const stockpile of resolved.stockpiles) {
    const authority = authorities.get(stockpile.stockpileId);
    if (authority?.kind === "delegation" && !coversAmounts(authority.remaining, stockpile.amount)) {
      return fail("draw-limit-exceeded", "超过委托余额");
    }
  }

  // 第 10 步 insufficient-resource：库存可用量（amount − reserved）不足。
  for (const stockpile of resolved.stockpiles) {
    const available = ports["game.resources"].stockpile(stockpile.stockpileId);
    if (available === null || !coversAmounts(subtractAmounts(available.amount, available.reserved), stockpile.amount)) {
      return fail("insufficient-resource", "库存可用量不足");
    }
  }

  return {
    ok: true,
    plan: {
      taskType: input.taskType,
      teamId: input.teamId,
      invitees: resolved.invitees,
      params: input.params,
      route: route.roadIds,
      departTick: resolved.departTick,
      nominalCompletionTick: resolved.departTick + route.duration,
      phase: "pending",
      reserved: resolved.stockpiles.reduce<ResourceAmounts>(
        (total, entry) => addAmounts(total, entry.amount),
        zeroResources,
      ),
      stockpiles: resolved.stockpiles,
      fromStockpileId: resolved.fromStockpileId,
      toStockpileId: resolved.toStockpileId,
      patrolStartTick: route.patrolStartTick,
      patrolEndTick: route.patrolEndTick,
      workStartTick: route.workStartTick,
      workNodeId: route.workNodeId,
    },
  };
}
