/**
 * 核心职责：声明通信模块内部共用的投递条目结构。
 * 交互契约：投递路由与端口实现共用该结构；只声明数据形状，不含行为。
 * 约束与禁忌：不在此定义端口契约或存储行结构。
 */

/**
 * 一条冻结的投递：投递对象与其到达的 world tick。
 *
 * 该结构会作为 JSON 写入通信聚合，因此显式声明索引签名，使其可直接赋给 Json
 * 而不需要在每个写入点做类型断言。
 */
export interface DeliveryRoute {
  readonly [key: string]: string | number;
  readonly principalId: string;
  readonly deliverAtTick: number;
}
