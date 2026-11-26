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

/** 排空报告的字段：只写标签、本次剩余预算与原因，不写可能含业务正文的消息体。 */
export interface DrainFailure {
  readonly label: string;
  readonly deadlineMs: number;
  readonly message: string;
}

/**
 * 在关闭前逐级排空资源，整体共享一个绝对截止时间。
 *
 * 为什么是共享预算而不是逐级传完整预算：逐级都给满额时，n 个层级的最坏耗时是 n 倍预算，
 * 关闭时间上界失效。这里先算出绝对截止时刻，每级只拿「剩余时间」，前一阶段拖得越久，
 * 后续阶段可用时间越少，整体不超过调用方给的一次预算。
 *
 * 契约 `ModuleInstance.drain(deadlineMs)` 承诺「停止新任务、设置短租约并等待提交边界」，
 * 而生产关闭路径此前只调 dispose，于是 `deadlineMs` 从未被传入。
 * 排空失败（含超过预算未排空）只记录并继续：释放必须照常发生，否则进程停在半关闭状态。
 */
export async function drainBeforeClose(
  steps: readonly DrainStep[],
  deadlineMs: number,
  report: (message: string, data: DrainFailure) => void,
): Promise<void> {
  const deadlineAt = Date.now() + Math.max(0, deadlineMs);
  for (const step of steps) {
    const remaining = Math.max(0, deadlineAt - Date.now());
    try {
      await step.drain(remaining);
    } catch (error) {
      report("宿主排空未完成", {
        label: step.label,
        deadlineMs: remaining,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 在绝对截止时刻前完成一次释放；超时只记录并放行，让关闭继续收尾。
 *
 * 为什么释放也要受限：排空超时说明某个主体卡住了，而它的 `dispose` 往往在等同一批在途
 * 工作。若释放不受预算约束，前面辛苦建立的关闭上界会被这一步重新打破。
 * 被放弃的释放仍在后台继续，`Promise.allSettled` 已吞掉其结果，不会产生未处理 rejection。
 */
export async function disposeWithin(
  release: () => Promise<void>,
  deadlineMs: number,
  label: string,
  report: (message: string, data: DrainFailure) => void,
): Promise<void> {
  const outcome = await settleWithin(release, deadlineMs);
  if (outcome === "timed-out") {
    report("宿主释放超时", { label, deadlineMs: Math.max(0, deadlineMs), message: "release did not finish in time" });
  }
}

/**
 * 在预算内等待一个 promise；返回是否按时完成，不吞掉实现本身的错误语义（由调用方决定）。
 * 超时后原 promise 仍被持有引用，其 rejection 由这里的 then 兜住。
 */
export async function settleWithin(work: () => Promise<void>, deadlineMs: number): Promise<"done" | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), Math.max(0, deadlineMs));
    timer.unref();
  });
  const running = work().then(() => "done" as const, (error: unknown) => {
    throw error;
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
