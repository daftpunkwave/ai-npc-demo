/**
 * 校验 task.dispatch 并计算任务路线、资源预留、邀请与完成 tick。
 * 依赖内容视图、地图/资源/世界端口、公共任务参数与 authority 上下文。
 * 禁止在这里写任务聚合、扣资源或发事件；计划只供派遣处理器提交。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将模块端口泛型误判为 any。 */
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
} from "@ai-npc/module-sdk";
import type { DispatchInput } from "./plan-types";
import { computeTaskRoute, type PlannedRoute } from "./routes";

export type { DispatchInput } from "./plan-types";

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

export type PlanResult =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | { readonly ok: false; readonly reasonCode: ReasonCode; readonly safeMessage: string };

type DispatchContext = HandlerContext<GameModulePorts, unknown>;

function fail(reasonCode: ReasonCode, safeMessage: string): PlanResult {
  return { ok: false, reasonCode, safeMessage };
}

function allowedWorkNodes(content: GameContent, input: DispatchInput, teamNodeId: string): readonly string[] {
  switch (input.taskType) {
    case "transport": {
      const params = input.params as { readonly fromStockpileId: string };
      const stockpile = content.stockpiles.get(params.fromStockpileId);
      return stockpile === undefined ? [] : [stockpile.nodeId];
    }
    case "escort": {
      const params = input.params as { readonly roadId: string };
      const road = content.roads.get(params.roadId);
      return road === undefined ? [] : [teamNodeId, road.a, road.b];
    }
    case "rescue": {
      const params = input.params as { readonly groupId: string };
      const group = content.groups.get(params.groupId);
      return group === undefined ? [] : [teamNodeId, group.nodeId];
    }
    case "repair":
      return [teamNodeId, "grayharbor"];
    case "scout": {
      const params = input.params as { readonly nodeId: string };
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
  const invitees = [...new Set(input.invitees ?? [])];
  const workNodes = allowedWorkNodes(content, input, teamView.nodeId);
  for (const inviteeId of invitees) {
    const character = ports["game.world"].character(inviteeId);
    if (character === null) {
      return fail("invalid-params", "受邀角色不存在");
    }
    if (
      (character.injuredUntilTick !== null && character.injuredUntilTick > context.tx.worldTick) ||
      character.currentTaskId !== null ||
      !workNodes.includes(character.nodeId)
    ) {
      return fail("participant-unavailable", "受邀角色当前不可参与该任务");
    }
  }

  const departAfter = input.departAfterTicks ?? (invitees.length > 0 ? 2 : 1);
  if (!Number.isSafeInteger(departAfter) || departAfter < 1 || departAfter > 6) {
    return fail("invalid-params", "出发延迟必须在 1–6 tick");
  }
  const departTick = context.tx.worldTick + departAfter;
  const reserved = zeroResources;
  const stockpiles: { stockpileId: string; amount: ResourceAmounts }[] = [];
  let fromStockpileId: string | null = null;
  let toStockpileId: string | null = null;

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
    fromStockpileId = from.stockpileId;
    toStockpileId = to.stockpileId;
    addReservation(stockpiles, from.stockpileId, params.cargo);
  } else if (input.taskType === "escort") {
    const params = input.params as { readonly roadId: string; readonly durationTicks?: number };
    if (!content.roads.has(params.roadId)) {
      return fail("invalid-params", "道路不存在");
    }
    if (params.durationTicks !== undefined && (params.durationTicks < 6 || params.durationTicks > 24)) {
      return fail("invalid-params", "护送时长必须在 6–24 tick");
    }
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
    if (ports["game.world"].group(params.groupId)?.status === "rescued") {
      return fail("invalid-params", "群体已经被救出");
    }
    const targetNode = content.nodes.get(params.toNodeId);
    if (targetNode === undefined || !targetNode.facilities.some((facility) => content.medicalFacilities.includes(facility))) {
      return fail("invalid-params", "救援目标没有医疗设施");
    }
    fromStockpileId = to.stockpileId;
    toStockpileId = to.stockpileId;
    addReservation(stockpiles, to.stockpileId, { supply: 0, energy: 0, medical: group.injured });
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
    fromStockpileId = energy.stockpileId;
    toStockpileId = supply?.stockpileId ?? null;
    addReservation(stockpiles, energy.stockpileId, { supply: 0, energy: 10, medical: 0 });
    if (supply !== undefined && input.teamId !== "team-star") {
      addReservation(stockpiles, supply.stockpileId, { supply: 5, energy: 0, medical: 0 });
    }
  } else if (!content.nodes.has((input.params as { readonly nodeId: string }).nodeId)) {
    return fail("invalid-params", "侦察节点不存在");
  }

  const route: PlannedRoute | null = computeTaskRoute(
    ports,
    content,
    input,
    teamView.nodeId,
    team.ownerFactionId,
    departTick,
    invitees,
  );
  if (route === null) {
    return fail("route-unavailable", "找不到可用路线");
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

  return {
    ok: true,
    plan: {
      taskType: input.taskType,
      teamId: input.teamId,
      invitees,
      params: input.params,
      route: route.roadIds,
      departTick,
      nominalCompletionTick: departTick + route.duration,
      phase: "pending",
      reserved: stockpiles.reduce<ResourceAmounts>((total, entry) => addAmounts(total, entry.amount), reserved),
      stockpiles,
      fromStockpileId,
      toStockpileId,
      patrolStartTick: route.patrolStartTick,
      patrolEndTick: route.patrolEndTick,
      workStartTick: route.workStartTick,
      workNodeId: route.workNodeId,
    },
  };
}
