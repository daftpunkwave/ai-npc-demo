/**
 * 实现库存预留、释放、消耗、转移与调整，并在同一事务内发出资源事件。
 * 依赖库存状态、内容初始值、mcn 资源运算与注入的 scoped WorldTx。
 * 禁止读取其他模块聚合、超预留扣减或在失败时留下部分资源变化。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import type { ReasonCode, ResourceAmounts, ResourceDelta, ResourceId } from "@ai-npc/contracts";
import {
  addAmounts,
  applyDelta,
  coversAmounts,
  factionAudience,
  gameModuleIds,
  isZeroAmounts,
  principalsAudience,
  requireGameContent,
  resourceIds,
  subtractAmounts,
  zeroResources,
  type GameContent,
  type GameResourcesPort,
  type ResourceLevel,
  type ScopedWorldTxFactory,
  type StockpileView,
} from "@ai-npc/module-sdk";
import { readStockpile, stockpileStateSchema, type StockpileState } from "./state";

export interface ResourcesPortOptions {
  readonly scarceRatio: number;
  readonly surplusRatio: number;
}

type OpFailure = { readonly ok: false; readonly reasonCode: ReasonCode };

function failure(reasonCode: ReasonCode): OpFailure {
  return { ok: false, reasonCode };
}

function levelOf(state: StockpileState, resource: ResourceId, options: ResourcesPortOptions): ResourceLevel {
  const baseline = Math.max(1, amountOf(state.baseline, resource));
  const ratio = amountOf(state.amount, resource) / baseline;
  if (ratio < options.scarceRatio) {
    return "scarce";
  }
  if (ratio > options.surplusRatio) {
    return "surplus";
  }
  return "adequate";
}

/** 以显式分支读取资源字段，避免把外部资源 ID 当作对象索引。 */
function amountOf(amountsValue: ResourceAmounts, resource: ResourceId): number {
  switch (resource) {
    case "supply":
      return amountsValue.supply;
    case "energy":
      return amountsValue.energy;
    case "medical":
      return amountsValue.medical;
  }
}

function reservationOf(state: StockpileState, taskId: string): ResourceAmounts | null {
  return state.reservations.find((entry) => entry.taskId === taskId)?.amount ?? null;
}

function addReservation(
  state: StockpileState,
  taskId: string,
  delta: ResourceAmounts,
): StockpileState["reservations"] {
  const existing = state.reservations.find((entry) => entry.taskId === taskId);
  if (existing === undefined) {
    return [...state.reservations, { taskId, amount: delta }];
  }
  return state.reservations.map((entry) =>
    entry.taskId === taskId ? { taskId, amount: addAmounts(entry.amount, delta) } : entry,
  );
}

function subtractReservation(
  state: StockpileState,
  taskId: string,
  delta: ResourceAmounts,
): StockpileState["reservations"] | null {
  const existing = reservationOf(state, taskId);
  if (existing === null || !coversAmounts(existing, delta)) {
    return null;
  }
  const next = subtractAmounts(existing, delta);
  if (isZeroAmounts(next)) {
    return state.reservations.filter((entry) => entry.taskId !== taskId);
  }
  return state.reservations.map((entry) =>
    entry.taskId === taskId ? { taskId, amount: next } : entry,
  );
}

/** 轻资源端口实现；所有方法共享同一个 scoped WorldTx。 */
class LightResourcesPort implements GameResourcesPort {
  private readonly txFor: ScopedWorldTxFactory;
  private readonly options: ResourcesPortOptions;

  constructor(txFor: ScopedWorldTxFactory, options: ResourcesPortOptions) {
    this.txFor = txFor;
    this.options = options;
  }

  private tx() {
    return this.txFor(gameModuleIds.resources);
  }

  private require(stockpileId: string): StockpileState | null {
    return readStockpile(this.tx(), stockpileId);
  }

  private save(state: StockpileState): void {
    this.tx().put("stockpile", state.stockpileId, state);
  }

  initializeCampaign(content: GameContent): void {
    const gameContent = requireGameContent(content);
    const tx = this.tx();
    for (const init of gameContent.stockpiles.values()) {
      if (tx.get<unknown>("stockpile", init.stockpileId) !== null) {
        continue;
      }
      const amount: ResourceAmounts = {
        supply: init.supply,
        energy: init.energy,
        medical: init.medical,
      };
      this.save({
        stockpileId: init.stockpileId,
        nodeId: init.nodeId,
        ownerFactionId: init.ownerFactionId,
        amount,
        reserved: zeroResources,
        baseline: amount,
        reservations: [],
      });
    }
  }

  stockpile(stockpileId: string): StockpileView | null {
    const state = this.require(stockpileId);
    if (state === null) {
      return null;
    }
    return { ...state };
  }

  available(stockpileId: string, resource: ResourceId): number {
    const state = this.require(stockpileId);
    return state === null ? 0 : amountOf(state.amount, resource) - amountOf(state.reserved, resource);
  }

  level(stockpileId: string): Readonly<Record<ResourceId, ResourceLevel>> {
    const state = this.require(stockpileId);
    if (state === null) {
      return { supply: "scarce", energy: "scarce", medical: "scarce" };
    }
    return {
      supply: levelOf(state, "supply", this.options),
      energy: levelOf(state, "energy", this.options),
      medical: levelOf(state, "medical", this.options),
    };
  }

  reserve(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | OpFailure {
    if (isZeroAmounts(input.delta)) {
      return failure("invalid-params");
    }
    const state = this.require(input.stockpileId);
    if (state === null) {
      return failure("invalid-params");
    }
    const available = subtractAmounts(state.amount, state.reserved);
    if (!coversAmounts(available, input.delta)) {
      return failure("insufficient-resource");
    }
    this.save({
      ...state,
      reserved: addAmounts(state.reserved, input.delta),
      reservations: addReservation(state, input.taskId, input.delta),
    });
    this.tx().emit(
      "ResourcesReserved",
      { stockpileId: input.stockpileId, delta: input.delta, taskId: input.taskId },
      [...principalsAudience([input.byId]), factionAudience(state.ownerFactionId)],
    );
    return { ok: true };
  }

  release(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | OpFailure {
    const state = this.require(input.stockpileId);
    if (state === null) {
      return failure("invalid-params");
    }
    const reservations = subtractReservation(state, input.taskId, input.delta);
    if (reservations === null) {
      return failure("invalid-params");
    }
    this.save({
      ...state,
      reserved: subtractAmounts(state.reserved, input.delta),
      reservations,
    });
    this.tx().emit(
      "ResourcesReleased",
      { stockpileId: input.stockpileId, delta: input.delta, taskId: input.taskId },
      [...principalsAudience([input.byId]), factionAudience(state.ownerFactionId)],
    );
    return { ok: true };
  }

  consume(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly reason: string;
    readonly taskId: string | null;
    readonly byId: string;
    readonly fromReservation?: boolean;
  }): { readonly ok: true } | OpFailure {
    if (isZeroAmounts(input.delta)) {
      return failure("invalid-params");
    }
    const state = this.require(input.stockpileId);
    if (state === null) {
      return failure("invalid-params");
    }
    const fromReservation = input.fromReservation ?? true;
    let reservations = state.reservations;
    if (fromReservation) {
      if (input.taskId === null) {
        return failure("invalid-params");
      }
      const nextReservations = subtractReservation(state, input.taskId, input.delta);
      if (nextReservations === null) {
        return failure("insufficient-resource");
      }
      reservations = nextReservations;
    } else {
      if (!coversAmounts(state.amount, input.delta)) {
        return failure("insufficient-resource");
      }
      if (!coversAmounts(subtractAmounts(state.amount, input.delta), state.reserved)) {
        return failure("insufficient-resource");
      }
    }
    this.save({
      ...state,
      amount: subtractAmounts(state.amount, input.delta),
      reserved: fromReservation ? subtractAmounts(state.reserved, input.delta) : state.reserved,
      reservations,
    });
    this.tx().emit(
      "ResourcesConsumed",
      { stockpileId: input.stockpileId, delta: input.delta, reason: input.reason, taskId: input.taskId },
      [...principalsAudience([input.byId]), factionAudience(state.ownerFactionId)],
    );
    return { ok: true };
  }

  transfer(input: {
    readonly fromStockpileId: string;
    readonly toStockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | OpFailure {
    if (isZeroAmounts(input.delta)) {
      return failure("invalid-params");
    }
    if (input.fromStockpileId === input.toStockpileId) {
      return failure("invalid-params");
    }
    const from = this.require(input.fromStockpileId);
    const to = this.require(input.toStockpileId);
    if (from === null || to === null) {
      return failure("invalid-params");
    }
    const reservations = subtractReservation(from, input.taskId, input.delta);
    if (reservations === null) {
      return failure("insufficient-resource");
    }
    this.save({
      ...from,
      amount: subtractAmounts(from.amount, input.delta),
      reserved: subtractAmounts(from.reserved, input.delta),
      reservations,
    });
    this.save({ ...to, amount: addAmounts(to.amount, input.delta) });
    this.tx().emit(
      "ResourcesTransferred",
      {
        fromStockpileId: input.fromStockpileId,
        toStockpileId: input.toStockpileId,
        delta: input.delta,
        taskId: input.taskId,
        dispatcherId: input.byId,
      },
      [...principalsAudience([input.byId]), factionAudience(from.ownerFactionId), factionAudience(to.ownerFactionId)],
    );
    return { ok: true };
  }

  adjust(input: {
    readonly stockpileId: string;
    readonly delta: ResourceDelta;
    readonly reason: string;
  }): { readonly ok: true } | OpFailure {
    const state = this.require(input.stockpileId);
    if (state === null) {
      return failure("invalid-params");
    }
    const nextAmount = applyDelta(state.amount, input.delta);
    if (!coversAmounts(nextAmount, state.reserved)) {
      return failure("insufficient-resource");
    }
    const applied: ResourceDelta = {};
    if (nextAmount.supply !== state.amount.supply) {
      applied.supply = nextAmount.supply - state.amount.supply;
    }
    if (nextAmount.energy !== state.amount.energy) {
      applied.energy = nextAmount.energy - state.amount.energy;
    }
    if (nextAmount.medical !== state.amount.medical) {
      applied.medical = nextAmount.medical - state.amount.medical;
    }
    this.save({ ...state, amount: nextAmount });
    this.tx().emit(
      "StockpileAdjusted",
      { stockpileId: input.stockpileId, delta: applied, reason: input.reason },
      [factionAudience(state.ownerFactionId), { kind: "node", nodeId: state.nodeId }],
    );
    return { ok: true };
  }
}

/** 构造绑定到当前事务的轻资源端口。 */
export function createResourcesPort(
  txFor: ScopedWorldTxFactory,
  options: ResourcesPortOptions,
): GameResourcesPort {
  return new LightResourcesPort(txFor, options);
}

/** 从资源库存状态构造对外快照；供资源模块自己的查询实现复用。 */
export function stockpileView(state: StockpileState): StockpileView {
  return {
    stockpileId: state.stockpileId,
    nodeId: state.nodeId,
    ownerFactionId: state.ownerFactionId,
    amount: state.amount,
    reserved: state.reserved,
    baseline: state.baseline,
  };
}

/** 保留 schema 引用，确保模块状态在读取时经过同一条严格校验路径。 */
export const stockpileSchema = stockpileStateSchema;

/** 资源字段的稳定顺序。 */
export const resourceOrder = resourceIds;
