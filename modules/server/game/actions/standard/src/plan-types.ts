/**
 * 行动派遣的公共输入类型，避免计划、路线与处理器互相导入实现。
 * 只描述命令 payload 的任务类型、队伍、邀请与参数。
 */
export type ActionTaskType = "transport" | "escort" | "rescue" | "repair" | "scout";

export interface DispatchInput {
  readonly taskType: ActionTaskType;
  readonly teamId: string;
  readonly invitees?: readonly string[];
  readonly departAfterTicks?: number;
  readonly params: Record<string, unknown>;
}
