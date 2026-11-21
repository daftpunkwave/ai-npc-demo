/**
 * 核心职责：执行进程关闭，把关闭结果转换为可观测的退出码与失败日志，并保证同一进程只关闭一次。
 * 交互契约：依赖调用方注入的关闭函数、错误日志与退出码写入；成功时退出码为 0。
 * 约束与禁忌：禁止吞掉关闭失败、在关闭失败后仍以 0 退出，或在重复信号下重复关闭并覆盖退出码。
 */

/** 关闭服务端所需的副作用端口；生产入口绑定进程退出码与控制台，测试可注入替身。 */
export interface ShutdownInput {
  readonly close: () => Promise<void>;
  readonly logError: (line: string) => void;
  readonly setExitCode: (code: number) => void;
}

/**
 * 关闭服务端资源：成功保持退出码 0；失败记录原因并以非零退出码结束。
 * 失败原因写入日志而不是抛出，避免异步关闭链在信号处理中产生未处理的 rejection。
 */
export async function shutdownServer(input: ShutdownInput): Promise<void> {
  try {
    await input.close();
    input.setExitCode(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.logError(`[ai-npc] 关闭失败：${message}`);
    input.setExitCode(1);
  }
}

/**
 * 构造只执行一次的关闭处理器：SIGINT 与 SIGTERM 共享同一个关闭任务，
 * 重复信号返回同一 Promise，不会并发关闭或覆盖已经确定的退出码。
 */
export function createShutdownHandler(input: ShutdownInput): () => Promise<void> {
  let task: Promise<void> | null = null;
  return () => {
    task ??= shutdownServer(input);
    return task;
  };
}
