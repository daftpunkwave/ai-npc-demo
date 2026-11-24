/**
 * 核心职责：渲染渲染器初始化失败的可见提示，把已转换的失败原因展示给玩家。
 * 交互契约：只接收文本原因；不读取渲染器状态、不触发重试或降级装配。
 * 约束与禁忌：不吞掉失败原因，也不把内部错误对象直接插入 DOM。
 */
import type { ReactNode } from "react";

export function SceneFailureNotice({ reason }: { readonly reason: string }): ReactNode {
  return (
    <div className="scene-error" role="alert">
      渲染后端不可用：{reason}
    </div>
  );
}
