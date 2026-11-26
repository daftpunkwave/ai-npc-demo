/**
 * 按任务类型计算完整路线、行程与工作窗口，供派遣和出发复用。
 * 依赖地图端口与内容道路/节点/库存点；只读，不写任务或资源。
 * 禁止在出发时信任派遣时缓存的路线，也禁止把救援拆成不经过群体节点的单段路线。
 */
import type { GameContent, GameModulePorts } from "@world-prism/module-sdk";
import { repairWorkNodeId, rescueDurationDiscount, scoutTravelDiscountPerRoad } from "./faction-bonus";
import type { DispatchInput } from "./plan-types";

export interface PlannedRoute {
  readonly roadIds: string[];
  readonly travelTicks: number;
  readonly duration: number;
  readonly workNodeId: string;
  readonly patrolStartTick: number | null;
  readonly patrolEndTick: number | null;
  readonly workStartTick: number | null;
}

interface Segment {
  readonly roadIds: string[];
  readonly travelTicks: number;
}

function segment(
  ports: GameModulePorts,
  fromNodeId: string,
  toNodeId: string,
  factionId: string,
  atTick: number,
  withCargo: boolean,
): Segment | null {
  if (fromNodeId === toNodeId) {
    return { roadIds: [], travelTicks: 0 };
  }
  const found = ports["game.map"].findRoute({ fromNodeId, toNodeId, factionId, atTick, withCargo });
  return found === null ? null : { roadIds: [...found.roadIds], travelTicks: found.travelTicks };
}

function join(first: Segment | null, second: Segment | null): Segment | null {
  if (first === null || second === null) {
    return null;
  }
  return {
    roadIds: [...first.roadIds, ...second.roadIds],
    travelTicks: first.travelTicks + second.travelTicks,
  };
}

/**
 * 用内容道路重算已选路径的行程；只改行程，不改 findRoute 选出的道路序列。
 * 每经过一条道路按折扣值减时，折扣来自内容规则岗位参数。
 * 内容缺少某条道路时退回原行程，避免算出与路径不一致的用时。
 */
function guidedTravelTicks(
  content: GameContent,
  roadIds: readonly string[],
  fallback: number,
  discountPerRoad: number,
): number {
  let total = 0;
  for (const roadId of roadIds) {
    const road = content.roads.get(roadId);
    if (road === undefined) {
      return fallback;
    }
    total += Math.max(1, road.travelTicks - discountPerRoad);
  }
  return total;
}

function nearestEndpoint(
  ports: GameModulePorts,
  teamNodeId: string,
  road: { readonly a: string; readonly b: string },
  factionId: string,
  atTick: number,
): { readonly nodeId: string; readonly segment: Segment } | null {
  if (teamNodeId === road.a) {
    return { nodeId: road.a, segment: { roadIds: [], travelTicks: 0 } };
  }
  if (teamNodeId === road.b) {
    return { nodeId: road.b, segment: { roadIds: [], travelTicks: 0 } };
  }
  const toA = segment(ports, teamNodeId, road.a, factionId, atTick, false);
  const toB = segment(ports, teamNodeId, road.b, factionId, atTick, false);
  if (toA !== null && (toB === null || toA.travelTicks <= toB.travelTicks)) {
    return { nodeId: road.a, segment: toA };
  }
  return toB === null ? null : { nodeId: road.b, segment: toB };
}

/** 计算任务路线；返回 null 表示按当前世界状态不可达。 */
export function computeTaskRoute(
  ports: GameModulePorts,
  content: GameContent,
  input: DispatchInput,
  teamNodeId: string,
  factionId: string,
  departTick: number,
  participants: readonly string[],
): PlannedRoute | null {
  if (input.taskType === "transport") {
    const params = input.params as { readonly fromStockpileId: string; readonly toStockpileId: string };
    const from = content.stockpiles.get(params.fromStockpileId);
    const to = content.stockpiles.get(params.toStockpileId);
    if (from === undefined || to === undefined) {
      return null;
    }
    const route = segment(ports, from.nodeId, to.nodeId, factionId, departTick, true);
    if (route === null) {
      return null;
    }
    return {
      ...route,
      duration: route.travelTicks,
      workNodeId: to.nodeId,
      patrolStartTick: null,
      patrolEndTick: null,
      workStartTick: null,
    };
  }
  if (input.taskType === "escort") {
    const params = input.params as { readonly roadId: string; readonly durationTicks?: number };
    const road = content.roads.get(params.roadId);
    if (road === undefined) {
      return null;
    }
    const endpoint = nearestEndpoint(ports, teamNodeId, road, factionId, departTick);
    if (endpoint === null) {
      return null;
    }
    const patrol = params.durationTicks ?? 12;
    const patrolStartTick = departTick + endpoint.segment.travelTicks;
    return {
      ...endpoint.segment,
      duration: endpoint.segment.travelTicks + patrol,
      workNodeId: endpoint.nodeId,
      patrolStartTick,
      patrolEndTick: patrolStartTick + patrol,
      workStartTick: null,
    };
  }
  if (input.taskType === "rescue") {
    const params = input.params as {
      readonly groupId: string;
      readonly toNodeId: string;
      readonly medicalStockpileId: string;
    };
    const group = content.groups.get(params.groupId);
    const to = content.stockpiles.get(params.medicalStockpileId);
    if (group === undefined || to === undefined || to.nodeId !== params.toNodeId) {
      return null;
    }
    const route = join(
      segment(ports, teamNodeId, group.nodeId, factionId, departTick, false),
      segment(ports, group.nodeId, params.toNodeId, factionId, departTick, false),
    );
    if (route === null) {
      return null;
    }
    // 救援用时折扣来自内容规则岗位参数（本派医政支持者）。
    const discount = rescueDurationDiscount(content, factionId, participants);
    return {
      ...route,
      duration: Math.max(1, route.travelTicks - discount),
      workNodeId: params.toNodeId,
      patrolStartTick: null,
      patrolEndTick: null,
      workStartTick: null,
    };
  }
  if (input.taskType === "repair") {
    // 修复工作节点来自内容规则参数，与派遣校验共用同一来源。
    const workNodeId = repairWorkNodeId(content);
    const route = segment(ports, teamNodeId, workNodeId, factionId, departTick, false);
    if (route === null) {
      return null;
    }
    return {
      ...route,
      duration: route.travelTicks + 6,
      workNodeId,
      patrolStartTick: null,
      patrolEndTick: null,
      workStartTick: departTick + route.travelTicks,
    };
  }
  const params = input.params as { readonly nodeId: string };
  if (!content.nodes.has(params.nodeId)) {
    return null;
  }
  const route = segment(ports, teamNodeId, params.nodeId, factionId, departTick, false);
  if (route === null) {
    return null;
  }
  // 侦察逐路折扣来自内容规则岗位参数；通用向导对任何队伍同效。
  const discountPerRoad = scoutTravelDiscountPerRoad(content, factionId, participants);
  const travelTicks =
    discountPerRoad > 0 ? guidedTravelTicks(content, route.roadIds, route.travelTicks, discountPerRoad) : route.travelTicks;
  return {
    roadIds: [...route.roadIds],
    travelTicks,
    duration: travelTicks + 2,
    workNodeId: params.nodeId,
    patrolStartTick: null,
    patrolEndTick: null,
    workStartTick: null,
  };
}
