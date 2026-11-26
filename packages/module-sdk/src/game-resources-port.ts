/**
 * 核心职责：定义资源模块的游戏端口与库存、委托动用权限视图类型。
 * 交互契约：依赖公共契约的资源量、资源增减、等级词表与原因码，以及内容索引的 campaign 初始化。
 * 约束与禁忌：禁止在这里实现规则或读写库存模块之外的聚合。
 */
/* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -- 接口参数名表达调用契约。 */
import type {
  ReasonCode,
  ResourceAmounts,
  ResourceDelta,
  ResourceId,
  ResourceLevel,
} from "@world-prism/contracts";
import type { GameContent } from "./game-content-index";

/** 库存点快照。 */
export interface StockpileView {
  readonly stockpileId: string;
  readonly nodeId: string;
  readonly ownerFactionId: string;
  readonly amount: ResourceAmounts;
  readonly reserved: ResourceAmounts;
  readonly baseline: ResourceAmounts;
}

/** 资源端口；预留、扣减与转移都由资源模块写自己的库存聚合。 */
export interface GameResourcesPort {
  initializeCampaign(content: GameContent): void;
  stockpile(stockpileId: string): StockpileView | null;
  available(stockpileId: string, resource: ResourceId): number;
  level(stockpileId: string): Readonly<Record<ResourceId, ResourceLevel>>;
  reserve(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  release(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  consume(input: {
    readonly stockpileId: string;
    readonly delta: ResourceAmounts;
    readonly reason: string;
    readonly taskId: string | null;
    readonly byId: string;
    readonly fromReservation?: boolean;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  transfer(input: {
    readonly fromStockpileId: string;
    readonly toStockpileId: string;
    readonly delta: ResourceAmounts;
    readonly taskId: string;
    readonly byId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
  adjust(input: {
    readonly stockpileId: string;
    readonly delta: ResourceDelta;
    readonly reason: string;
  }): { readonly ok: true } | { readonly ok: false; readonly reasonCode: ReasonCode };
}
