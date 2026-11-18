/**
 * 校验 task.dispatch 并计算任务路线、资源预留、邀请与完成 tick。
 * 依赖内容视图、地图/资源/世界端口、公共任务参数与 authority 上下文。
 * 禁止在这里写任务聚合、扣资源或发事件；计划只供派遣处理器提交。
 */
import type { ReasonCode, ResourceAmounts } from "@ai-npc/contracts";
import {
  addAmounts,
  coversAmounts,
  requireGameContent,
  totalAmount,
  zeroResources,
  type GameContent,
  type GameModulePorts,
  type HandlerContext,
  type RouteResult,
} from "@ai-npc/module-sdk";

export type DispatchInput = {
  readonly taskType: "transport" | "escort" | "rescue" | "repair" | "scout";
  readonly teamId: string;
  readonly invitees?: readonly string[];
  readonly departAfterTicks?: number;
  readonly params: Record<string, unknown>;
};

export interface DispatchPlan {
  readonly taskType: DispatchInput["taskType"];
  readonly teamId: string;
  readonly invitees: readonly string[];
  readonly params: Record<string, unknown>;
  readonly route: readonly string[];
  readonly departTick: number;
  readonly nominalCompletionTick: number;
  readonly phase: "pending" | "traveling" | "working";
  readonly reserved: ResourceAmounts;
  readonly stockpiles: readonly { readonly stockpileId: string; readonly amount: ResourceAmounts }[];
  readonly fromStockpileId: string | null;
  readonly toStockpileId: string | null;
  readonly patrolStartTick: number | null;
  readonly patrolEndTick: number | null;
  readonly workStartTick: number | null;
  readonly workNodeId: string | null;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

type DispatchContext = HandlerContext<GameModulePorts, unknown>;

function fail(reasonCode: ReasonCode, safeMessage: string): PlanResult {
  return { ok: false, reasonCode, safeMessage };
}

function routeBetween(
  ports: GameModulePorts,
  fromNodeId: string,
  toNodeId: string,
  factionId: string,
  atTick: number,
  withCargo: boolean,
): RouteResult | null {
  if (fromNodeId === toNodeId) {
    return { roadIds: [], travelTicks: 0 };
  }
  return ports["game.map"].findRoute({ fromNodeId, toNodeId, factionId, atTick, withCargo });
}

function joinRoutes(first: RouteResult | null, second: RouteResult | null): RouteResult | null {
  if (first === null || second === null) {
    return null;
  }
  return {
    roadIds: [...first.roadIds, ...second.roadIds],
    travelTicks: first.travelTicks + second.travelTicks,
  };
}

function nodeOf(ports: GameModulePorts, principalId: string): string | null {
  return ports["game.world"].character(principalId)?.nodeId ?? null;
}

function allowedWorkNodes(content: GameContent, plan: DispatchInput, teamNodeId: string): readonly string[] {
  switch (plan.taskType) {
    case "transport": {
      const params = plan.params as { readonly fromStockpileId: string };
      const stockpile = content.stockpiles.get(params.fromStockpileId);
      return stockpile === undefined ? [] : [stockpile.nodeId];
    }
    case "escort": {
      const params = plan.params as { readonly roadId: string };
      const road = content.roads.get(params.roadId);
      return road === undefined ? [] : [teamNodeId, road.a, road.b];
    }
    case "rescue": {
      const params = plan.params as { readonly groupId: string };
      const group = content.groups.get(params.groupId);
      return group === undefined ? [] : [teamNodeId, group.nodeId];
    }
    case "repair":
      return [teamNodeId, "grayharbor"];
    case "scout": {
      const params = plan.params as { readonly nodeId: string };
      return [teamNodeId, params.nodeId];
    }
  }
}

function addReservation(
  stockpiles: { stockpileId: string; amount: ResourceAmounts }[],
  stockpileId: string,
  amount: ResourceAmounts,
): void {
  const existing = stockpiles.find((entry) => entry.stockpileId === stockpileId);
  if (existing === undefined) {
    stockpiles.push({ stockpileId, amount });
  } else {
    existing.amount = addAmounts(existing.amount, amount);
  }
}

/** 校验并计算一次派遣；任何失败都不写状态。 */
export function planDispatch(context: DispatchContext, input: DispatchInput): PlanResult {
  const content = requireGameContent(context.content);
  const ports = context.modules;
  const team = content.teams.get(input.teamId);
  if (team === undefined) {
    return fail("invalid-params", "队伍不存在");
  }
  const teamView = ports["game.world"].team(input.teamId);
  if (teamView === null) {
    return fail("invalid-params", "队伍状态不存在");
  }
  if (teamView.status !== "idle") {
    return fail("team-busy", "队伍正在执行其他任务");
  }
  if (!teamView.capabilities.includes(input.taskType)) {
    return fail("capability-missing", "队伍缺少该任务能力");
  }
  const dispatcher = context.auth.actingAsAgentId ?? context.auth.principalId;
  if (!ports["game.world"].canDispatchTeam(dispatcher, input.teamId)) {
    return fail("no-authority", "派遣者没有该队伍的有效授权");
  }
  const invitees = [...(input.invitees ?? [])];
  const workNodes = allowedWorkNodes(content, input, team.nodeId);
  for (const inviteeId of invitees) {
    const character = ports["game.world"].character(inviteeId);
    if (character === null) {
      return fail("invalid-params", "受邀角色不存在");
    }
    if (
      character.injuredUntilTick !== null && character.injuredUntilTick > context.tx.worldTick ||
      character.currentTaskId !== null ||
      !workNodes.includes(character.nodeId)
    ) {
      return fail("participant-unavailable", "受邀角色当前不可参与该任务");
    }
  }

  let route: RouteResult | null = null;
  let duration = 0;
  let fromStockpileId: string | null = null;
  let toStockpileId: string | null = null;
  let patrolStartTick: number | null = null;
  let patrolEndTick: number | null = null;
  let workStartTick: number | null = null;
  let workNodeId: string | null = null;
  const reserved = zeroResources;
  const stockpiles: { stockpileId: string; amount: ResourceAmounts }[] = [];
  const atTick = context.tx.worldTick;

  if (input.taskType === "transport") {
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
    if (teamView.nodeId !== from.nodeId) {
      return fail("team-not-at-origin", "队伍不在运输起点");
    }
    if (totalAmount(params.cargo) === 0) {
      return fail("invalid-params", "运输货物不能全为零");
    }
    const capacity = teamView.capacity + (invitees.includes("npc-wenyuan") ? 5 : 0);
    if (totalAmount(params.cargo) > capacity) {
      return fail("over-capacity", "货物超过队伍运力");
    }
    route = routeBetween(ports, from.nodeId, to.nodeId, team.ownerFactionId, atTick, true);
    if (route === null) {
      return fail("route-unavailable", "找不到可用路线");
    }
    duration = route.travelTicks;
    fromStockpileId = from.stockpileId;
    toStockpileId = to.stockpileId;
    addReservation(stockpiles, from.stockpileId, params.cargo);
    workNodeId = to.nodeId;
  } else if (input.taskType === "escort") {
    const params = input.params as { readonly roadId: string; readonly durationTicks?: number };
    const road = content.roads.get(params.roadId);
    if (road === undefined) {
      return fail("invalid-params", "道路不存在");
    }
    if (teamView.nodeId === road.a) {
      workNodeId = road.a;
      route = { roadIds: [], travelTicks: 0 };
    } else if (teamView.nodeId === road.b) {
      workNodeId = road.b;
      route = { roadIds: [], travelTicks: 0 };
    } else {
      const toA = routeBetween(ports, teamView.nodeId, road.a, team.ownerFactionId, atTick, false);
      const toB = routeBetween(ports, teamView.nodeId, road.b, team.ownerFactionId, atTick, false);
      if (toA !== null && (toB === null || toA.travelTicks <= toB.travelTicks)) {
        workNodeId = road.a;
        route = toA;
      } else {
        workNodeId = road.b;
        route = toB;
      }
    }
    if (route === null) {
      return fail("route-unavailable", "找不到前往护送道路的路线");
    }
    const patrol = params.durationTicks ?? 12;
    patrolStartTick = atTick + route.travelTicks;
    patrolEndTick = patrolStartTick + patrol;
    duration = route.travelTicks + patrol;
  } else if (input.taskType === "rescue") {
    const params = input.params as {
      readonly groupId: string;
      readonly toNodeId: string;
      readonly medicalStockpileId: string;
    };
    const group = content.groups.get(params.groupId);
    const to = content.stockpiles.get(params.medicalStockpileId);
    if (group === undefined || to === undefined || to.nodeId !== params.toNodeId) {
      return fail("invalid-params", "救援群体或医疗库存点不合法");
    }
    const targetNode = content.nodes.get(params.toNodeId);
    if (targetNode === undefined || !targetNode.facilities.some((facility) => content.medicalFacilities.includes(facility))) {
      return fail("invalid-params", "救援目标没有医疗设施");
    }
    const toGroup = routeBetween(ports, teamView.nodeId, group.nodeId, team.ownerFactionId, atTick, false);
    const toTarget = routeBetween(ports, group.nodeId, params.toNodeId, team.ownerFactionId, atTick, false);
    route = joinRoutes(toGroup, toTarget);
    if (route === null) {
      return fail("route-unavailable", "找不到救援路线");
    }
    const helpers = invitees.includes("npc-suhui") || invitees.includes("npc-linwu");
    duration = Math.max(1, route.travelTicks - (helpers ? 2 : 0));
    fromStockpileId = to.stockpileId;
    toStockpileId = to.stockpileId;
    addReservation(stockpiles, to.stockpileId, { supply: 0, energy: 0, medical: group.injured });
    workNodeId = params.toNodeId;
  } else if (input.taskType === "repair") {
    const params = input.params as {
      readonly energyStockpileId: string;
      readonly supplyStockpileId: string | null;
    };
    const energy = content.stockpiles.get(params.energyStockpileId);
    const supply = params.supplyStockpileId === null ? undefined : content.stockpiles.get(params.supplyStockpileId);
    if (energy === undefined || (params.supplyStockpileId !== null && supply === undefined)) {
      return fail("invalid-params", "修复材料库存点不存在");
    }
    if (energy.nodeId !== "grayharbor" && energy.nodeId !== teamView.nodeId) {
      return fail("invalid-params", "能源库存点不在工作节点");
    }
    if (supply !== undefined && supply.nodeId !== "grayharbor" && supply.nodeId !== teamView.nodeId) {
      return fail("invalid-params", "供给库存点不在工作节点");
    }
    route = routeBetween(ports, teamView.nodeId, "grayharbor", team.ownerFactionId, atTick, false);
    if (route === null) {
      return fail("route-unavailable", "找不到前往灰港的路线");
    }
    duration = route.travelTicks + 6;
    workStartTick = atTick + route.travelTicks;
    workNodeId = "grayharbor";
    fromStockpileId = energy.stockpileId;
    toStockpileId = supply?.stockpileId ?? null;
    addReservation(stockpiles, energy.stockpileId, { supply: 0, energy: 10, medical: 0 });
    if (supply !== undefined && input.teamId !== "team-star") {
      addReservation(stockpiles, supply.stockpileId, { supply: 5, energy: 0, medical: 0 });
    }
  } else {
    const params = input.params as { readonly nodeId: string };
    if (!content.nodes.has(params.nodeId)) {
      return fail("invalid-params", "侦察节点不存在");
    }
    route = routeBetween(ports, teamView.nodeId, params.nodeId, team.ownerFactionId, atTick, false);
    if (route === null) {
      return fail("route-unavailable", "找不到侦察路线");
    }
    duration = route.travelTicks + 2;
    workNodeId = params.nodeId;
  }

  for (const stockpile of stockpiles) {
    const authority = ports["game.world"].drawAuthority(dispatcher, stockpile.stockpileId);
    if (authority.kind === "none" && !context.auth.roles.includes("system")) {
      return fail("no-authority", "没有该库存点的动用权");
    }
    if (authority.kind === "delegation" && !coversAmounts(authority.remaining, stockpile.amount)) {
      return fail("draw-limit-exceeded", "超过委托余额");
    }
    const available = ports["game.resources"].stockpile(stockpile.stockpileId);
    if (
      available === null ||
      available.amount.supply - available.reserved.supply < stockpile.amount.supply ||
      available.amount.energy - available.reserved.energy < stockpile.amount.energy ||
      available.amount.medical - available.reserved.medical < stockpile.amount.medical
    ) {
      return fail("insufficient-resource", "库存可用量不足");
    }
  }

  const inviteCount = invitees.length;
  const departAfter = input.departAfterTicks ?? (inviteCount > 0 ? 2 : 1);
  if (!Number.isSafeInteger(departAfter) || departAfter < 1 || departAfter > 6) {
    return fail("invalid-params", "出发延迟必须在 1–6 tick");
  }
  const departTick = atTick + departAfter;
  return {
    ok: true,
    plan: {
      taskType: input.taskType,
      teamId: input.teamId,
      invitees,
      params: input.params,
      route: route.roadIds,
      departTick,
      nominalCompletionTick: departTick + duration,
      phase: "pending",
      reserved: stockpiles.reduce<ResourceAmounts>((total, entry) => addAmounts(total, entry.amount), reserved),
      stockpiles,
      fromStockpileId,
      toStockpileId,
      patrolStartTick,
      patrolEndTick,
      workStartTick,
      workNodeId,
    },
  };
}
