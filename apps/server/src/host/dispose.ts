/**
 * 宿主资源释放：按传入顺序的逆序执行，任一失败仍继续释放其余实例，最后汇总抛出。
 * 依赖各资源自身的 dispose 回调；不持有资源、不判断何时关闭。
 * 禁止在启动失败路径上跳过后续清理，也禁止把清理错误覆盖原始启动错误（调用方只记录日志）。
 */
/** 单个待释放资源：标签只用于错误汇总与日志，不参与资源寻址。 */
export interface DisposalStep {
  readonly label: string;
  readonly dispose: () => Promise<void>;
}

/**
 * 按传入顺序的逆序释放资源；任一步失败都继续释放其余实例，最后把全部错误汇总抛出。
 * 启动失败路径用日志保留原始启动错误，关闭路径用 AggregateError 让调用方看到未完成的清理。
 */
export async function disposeInReverse(steps: readonly DisposalStep[]): Promise<void> {
  const failures: { readonly label: string; readonly error: unknown }[] = [];
  for (const step of steps.toReversed()) {
    try {
      await step.dispose();
    } catch (error) {
      failures.push({ label: step.label, error });
    }
  }
  if (failures.length === 0) {
    return;
  }
  const detail = failures
    .map((failure) => `${failure.label}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)
    .join("；");
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `宿主清理未全部完成：${detail}`,
  );
}

/** 单个待排空资源：与释放步骤同构，但语义是「不再接受新工作，等待提交边界」。 */
export interface DrainStep {
  readonly label: string;
  readonly drain: (deadlineMs: number) => Promise<void>;
}

/**
 * 在关闭前逐级排空资源，每级都有独立的截止时间。
 * 契约 `ModuleInstance.drain(deadlineMs)` 承诺「停止新任务、设置短租约并等待提交边界」，
 * 但生产关闭路径此前只调 dispose，于是契约里的截止时间从未被传入，单个卡住的 turn 就能拖住进程退出。
 * 排空失败（含超过预算未排空）只记录并继续释放：释放必须照常发生，否则进程停在半关闭状态。
 */
export async function drainBeforeClose(
  steps: readonly DrainStep[],
  deadlineMs: number,
  report: (message: string, data: { readonly label: string; readonly deadlineMs: number; readonly message: string }) => void,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.drain(deadlineMs);
    } catch (error) {
      report("宿主排空未完成", {
        label: step.label,
        deadlineMs,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
