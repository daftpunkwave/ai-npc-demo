/**
 * 核心职责：实现世界端口的指标读写操作与指标视图的取值、替换纯函数。
 * 交互契约：依赖注入的 scoped WorldTx、指标阈值规则与水门配额词表。
 * 约束与禁忌：禁止写入地图或库存聚合；阈值事件与钳制规则以 meters.ts 为准。
 */
import { type MeterChange, type MeterChangeCause, type NumericMeterId, type WatergateAllocation } from "@world-prism/contracts";
import type { GameWorldPort, MetersView, ScopedWorldTxFactory } from "@world-prism/module-sdk";
import { worldModuleDefinition } from "./definition";
import { clampMeter, thresholdEvents } from "./meters";
import { metersAggregateId } from "./port-aggregates";
import { failure, type OpFailure, type OpSuccess } from "./port-result";
import { metersStateSchema, readWorldState, type MetersState } from "./state";

export function viewOfMeters(state: MetersState): MetersView {
  return {
    "relay.stability": state["relay.stability"],
    "orchard.water": state["orchard.water"],
    "migration.safety": state["migration.safety"],
    "watergate.allocation": state["watergate.allocation"],
  };
}

export function meterValue(view: MetersView, meter: NumericMeterId): number {
  switch (meter) {
    case "relay.stability":
      return view["relay.stability"];
    case "orchard.water":
      return view["orchard.water"];
    case "migration.safety":
      return view["migration.safety"];
  }
}

export function setMeter(view: MetersView, meter: NumericMeterId, value: number): MetersView {
  switch (meter) {
    case "relay.stability":
      return { ...view, "relay.stability": value };
    case "orchard.water":
      return { ...view, "orchard.water": value };
    case "migration.safety":
      return { ...view, "migration.safety": value };
  }
}

/** 世界端口指标操作的依赖：调用方作用域事务工厂。 */
export interface WorldMeterOpsDeps {
  readonly txFor: ScopedWorldTxFactory;
}

export function createWorldMeterOps({ txFor }: WorldMeterOpsDeps): Pick<
  GameWorldPort,
  "changeMeter" | "setAllocation"
> {
  const tx = () => txFor(worldModuleDefinition.id);
  return {
    changeMeter(meter: NumericMeterId, delta: number, cause: MeterChangeCause): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "meters", metersAggregateId, metersStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      const state = record.state;
      const previous = viewOfMeters(state);
      const previousValue = meterValue(previous, meter);
      const next = setMeter(previous, meter, clampMeter(previousValue + delta));
      const nextValue = meterValue(next, meter);
      const change: MeterChange | null =
        previousValue === nextValue ? null : { meter, from: previousValue, to: nextValue, cause };
      const threshold = thresholdEvents(previous, next, new Set(state.triggered));
      const triggered = [...state.triggered, ...threshold.added];
      tx().put("meters", metersAggregateId, { ...state, ...next, triggered });
      if (change !== null) {
        tx().emit("MetersChanged", { changes: [change] }, [{ kind: "public" }]);
      }
      for (const event of threshold.events) {
        tx().emit(event.type, { value: event.value }, [{ kind: "public" }]);
      }
      return { ok: true };
    },

    setAllocation(allocation: WatergateAllocation, byId: string): OpSuccess | OpFailure {
      const record = readWorldState(tx(), "meters", metersAggregateId, metersStateSchema);
      if (record === null) {
        return failure("invalid-params");
      }
      const oldValue = record.state["watergate.allocation"];
      if (oldValue === allocation) {
        return failure("no-change");
      }
      tx().put("meters", metersAggregateId, { ...record.state, "watergate.allocation": allocation });
      tx().emit(
        "PolicyChanged",
        { key: "watergate.allocation", oldValue, newValue: allocation, byId },
        [{ kind: "public" }],
      );
      return { ok: true };
    },
  };
}
