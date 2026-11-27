/**
 * 核心职责：定义资源模块的游戏端口与库存、库存等级、委托动用权限视图类型。
 * 交互契约：依赖公共契约的资源量、资源增减、等级词表与原因码，以及内容索引的 campaign 初始化；
 * 需要全部库存点的读取方用批量查询一次取得快照与等级，按 ID 的单点查询留给只关心个别库存点的规则路径。
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

/** 库存点三类资源相对开局基线的展示等级；阈值取自资源模块配置。 */
export type StockpileLevels = Readonly<Record<ResourceId, ResourceLevel>>;

/** 库存点快照及其展示等级。 */
export interface StockpileStatus extends StockpileView {
  readonly levels: StockpileLevels;
}

/** 资源端口；预留、扣减与转移都由资源模块写自己的库存聚合。 */
export interface GameResourcesPort {
  initializeCampaign(content: GameContent): void;
  stockpile(stockpileId: string): StockpileView | null;
  /**
   * 全部已初始化库存点的快照与展示等级，按库存点 ID 升序；开局初始化前为空集合。
   * 一次读出、每个库存点只解析一次，读取方不必再按 ID 逐个回查快照与等级。
   */
  stockpiles(): readonly StockpileStatus[];
  available(stockpileId: string, resource: ResourceId): number;
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
