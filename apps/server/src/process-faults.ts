/**
 * 核心职责：注册进程级 unhandledRejection 与 uncaughtException 处理器，把未捕获异常转成可诊断的降级退出。
 * 交互契约：注入关闭回调与退出码写入函数；处理器只决定「记录后退出」还是「记录后继续」，不直接结束进程。
 * 约束与禁忌：禁止空实现吞掉异常并把降级服务伪装成正常，也禁止在处理器里再次抛出未处理 rejection。
 */

/** 单个未捕获异常的记录内容：只保留结构化字段，不携带可能含观察正文的自由文本。 */
export interface ProcessFaultReport {
  readonly kind: "unhandledRejection" | "uncaughtException";
  readonly message: string;
  readonly stack: string | null;
}

/**
 * 进程级异常策略的依赖：记录、请求关闭与写入退出码。
 * 关闭回调必须幂等（`createShutdownHandler` 已保证），重复故障不会重复关闭。
 */
export interface ProcessFaultHandlersInput {
  readonly logFault: (report: ProcessFaultReport) => void;
  readonly shutdown: () => Promise<void>;
  readonly setExitCode: (code: number) => void;
  /** 故障后是否继续服务；单机宿主默认失败即退出，因为状态已不可信。 */
  readonly exitOnFault?: boolean;
}

/** 故障后使用的退出码：非零且与关闭失败（1）区分，便于运维按码定位。 */
export const faultExitCode = 70;

/**
 * 构造两个进程级处理器。
 *
 * 为什么不是空实现：Node 15 起未处理的 rejection 会直接终止进程，此时既没有 drain 也没有
 * 结构化记录，SQLite 只能靠 WAL 恢复，是「进程消失且无痕」的最差失败模式；反过来把处理器
 * 写成空实现，会让服务停在非法状态并继续对外承诺可用，属于仓库明令禁止的吞错。
 *
 * 因此这里统一为「结构化记录 → 标记降级退出码 → 走既有优雅关闭」。`exitOnFault: false`
 * 只给测试与需要在隔离后继续的组合使用，默认不放开。
 */
export function createProcessFaultHandlers(input: ProcessFaultHandlersInput): {
  readonly unhandledRejection: (reason: unknown) => void;
  readonly uncaughtException: (error: unknown) => void;
  /** 已发生的故障次数；重复故障不重复触发关闭，但都要记录。 */
  faults(): number;
} {
  const exitOnFault = input.exitOnFault ?? true;
  let resolved = false;
  let count = 0;

  const handle = (kind: ProcessFaultReport["kind"], error: unknown): void => {
    count += 1;
    input.logFault({
      kind,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    });
    if (!exitOnFault) return;
    input.setExitCode(faultExitCode);
    // 关闭本身失败时不能抛出：处理器是进程最后一道防线，再抛就回到「无记录退出」。
    if (resolved) return;
    resolved = true;
    void input.shutdown().catch(() => undefined);
  };

  return {
    unhandledRejection: (reason) => { handle("unhandledRejection", reason); },
    uncaughtException: (error) => { handle("uncaughtException", error); },
    faults: () => count,
  };
}

/**
 * 把处理器挂到进程上，返回解除注册的函数。
 * 单独抽出是为了让测试能干净地装卸，不污染同进程内其他用例的全局状态。
 */
export function installProcessFaultHandlers(
  target: Pick<NodeJS.Process, "on" | "off">,
  handlers: ReturnType<typeof createProcessFaultHandlers>,
): () => void {
  const onRejection = (reason: unknown): void => { handlers.unhandledRejection(reason); };
  const onException = (error: unknown): void => { handlers.uncaughtException(error); };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}
