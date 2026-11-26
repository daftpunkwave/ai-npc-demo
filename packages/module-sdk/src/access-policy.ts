/**
 * 核心职责：定义访问裁决端口的唯一类型来源，供传输层与已装配的权限 provider 共用。
 * 交互契约：只声明动作、请求与裁决结构；裁决由注入的 provider 给出，本模块不做任何角色判定。
 * 约束与禁忌：禁止在这里内置角色白名单、读取配置或依赖具体 provider 实现。
 */

/** 需要裁决的动作：玩家入口、命令、控制台接口、控制台会话握手与 WS 频道。 */
export type AccessAction = "player" | "command" | "console" | "console-session" | "channel";

/**
 * 权限裁决请求：主体与角色始终来自服务端会话，调用方只补充动作与目标。
 * 传输层按本结构调用 provider，不自行推断角色。
 */
export interface AccessRequest {
  readonly principalId: string;
  readonly role: string;
  readonly action: AccessAction;
  readonly commandType?: string;
  readonly channel?: string;
}

/**
 * 裁决原因。`unknown-role` 表示请求角色不在 provider 的配置范围内，属于装配或配置问题；
 * `forbidden` 表示角色合法但无权执行该动作。两者都是拒绝，但排障含义不同，
 * 因此用字面量联合表达，避免调用方按字符串内容猜测。
 */
export type AccessDecisionReason = "allowed" | "forbidden" | "unknown-role";

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: AccessDecisionReason;
}

/** 权限端口最小视图；角色白名单由装配的 provider 维护。 */
export interface AccessPolicy {
  authorize(request: AccessRequest): AccessDecision;
}
