/**
 * 核心职责：把宿主内部错误按统一口径写入宿主日志。
 * 交互契约：依赖 @ai-npc/contracts 的 DomainError、loggableErrorDetails 与 HostLogger 端口。
 * 约束与禁忌：领域错误 details 必须经白名单过滤后记录，禁止直接展开 error.details；本函数不得抛出。
 */
import { DomainError, loggableErrorDetails, type HostLogger } from "@ai-npc/contracts";

/**
 * 以统一口径记录内部错误：文本取错误自身的 message，领域错误额外附白名单过滤后的 details。
 * 非 Error 值按字符串记录；自由文本与供应商报文不会进入日志。
 */
export function logInternalError(logger: HostLogger, message: string, error: unknown): void {
  try {
    logger.error(message, {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DomainError ? { details: loggableErrorDetails(error.details) } : {}),
    });
  } catch {
    // logger 失败没有备用输出通道，吞掉异常保护调用方主流程，与传输层 report 的口径一致。
  }
}
