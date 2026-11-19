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
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined) {
      continue;
    }
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
