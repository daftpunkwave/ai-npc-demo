/**
 * 核心职责：计算通信投递时刻与冻结投递名单：同节点立即到达，异节点按中继状态延迟或判定不可达。
 * 交互契约：输入频道、发送者与收件者标识，以及「节点查询」「中继状态」「当前 tick」三个只读回读函数；
 * 返回投递时刻、relay-down 标记或按 principalId 排序的投递名单。
 * 约束与禁忌：不写存储、不追加对白，也不在中继不可达时静默丢弃定向消息。
 */
import { comparePrincipalIds } from "@world-prism/contracts";
import type { DeliveryRoute } from "./comms-types";

/** 投递路由需要的只读上下文。 */
export interface DeliveryRoutingInput {
  /** 当前世界 tick；由调用方在读取事务内提供。 */
  readonly worldTick: () => number;
  /** 中继的运行状态。 */
  readonly relayState: () => "normal" | "degraded" | "down";
  /** 主体所在节点；未知主体返回 null。 */
  readonly principalNode: (principalId: string) => string | null;
  /** 两个主体是否在同一节点。 */
  readonly sameNode: (fromId: string, toId: string) => boolean;
}

/** 通信频道；三种频道的延迟规则不同。 */
export type CommsChannel = "dialogue" | "message" | "broadcast";

/**
 * 同一节点立即送达；异地按中继状态延迟，中继不可用时判定不可达。
 * 对白与消息的延迟不同：对白是即时交谈，消息需要一次路由跳转。
 */
export function arrivalAt(
  input: DeliveryRoutingInput,
  channel: CommsChannel,
  samePlace: boolean,
): number | "relay-down" {
  const tick = input.worldTick();
  if (samePlace) {
    return tick;
  }
  const state = input.relayState();
  if (state === "down") {
    return "relay-down";
  }
  if (channel === "dialogue") {
    return state === "degraded" ? tick + 2 : tick;
  }
  return state === "degraded" ? tick + 3 : tick + 1;
}

/** 定向通信：发送者立即回显，其余收件者按同节点与中继状态计算。 */
export function directedArrival(
  input: DeliveryRoutingInput,
  channel: "dialogue" | "message",
  fromId: string,
  toId: string,
): number | "relay-down" {
  if (fromId === toId) {
    return input.worldTick();
  }
  return arrivalAt(input, channel, input.sameNode(fromId, toId));
}

/** 广播的同节点判定以发布位置为准；发布位置未知时任何收件者都按异地处理。 */
export function broadcastArrival(
  input: DeliveryRoutingInput,
  originNodeId: string | null,
  toId: string,
): number | "relay-down" {
  const toNode = input.principalNode(toId);
  return arrivalAt(input, "broadcast", originNodeId !== null && toNode === originNodeId);
}

/** 对外的投递时刻入口：广播按发布位置判定，其余按定向规则。 */
export function deliverAt(
  input: DeliveryRoutingInput,
  channel: CommsChannel,
  fromId: string,
  toId: string,
): number | "relay-down" {
  if (channel === "broadcast") {
    return broadcastArrival(input, input.principalNode(fromId), toId);
  }
  return directedArrival(input, channel, fromId, toId);
}

/**
 * 冻结投递名单：按 principalId 排序去重。定向通信中任一收件者不可达就整条返回 null，
 * 广播则只保留与发布位置同节点的主体。
 */
export function deliveries(
  input: DeliveryRoutingInput,
  channel: CommsChannel,
  fromId: string,
  recipients: readonly string[],
  originNodeId?: string | null,
): readonly DeliveryRoute[] | null {
  const unique = [...new Set([fromId, ...recipients])].sort(comparePrincipalIds);
  const output: DeliveryRoute[] = [];
  for (const principalId of unique) {
    const at = channel === "broadcast"
      ? broadcastArrival(input, originNodeId ?? null, principalId)
      : directedArrival(input, channel, fromId, principalId);
    if (at === "relay-down") {
      if (channel !== "broadcast") {
        return null;
      }
      continue;
    }
    output.push({ principalId, deliverAtTick: at });
  }
  return output;
}
