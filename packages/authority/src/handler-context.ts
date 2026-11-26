/**
 * 为一类规则处理器构造事务内 HandlerContext，统一注入认证、WorldTx、模块端口与绑定 runSeed 的随机源。
 * 依赖公共契约的认证/宿主类型与 module-sdk 的处理器上下文；不持有连接或跨事务缓存。
 * 禁止把未绑定所有权的 WorldTx、原始存储事务或模型凭据塞进上下文。
 */
import type { AuthContext } from "@world-prism/contracts";
import type { HostServices } from "@world-prism/contracts";
import type { ApprovedSpeechReader, HandlerContext } from "@world-prism/module-sdk";
import type { TransactionWorldTx } from "./world-tx";

/** 构造上下文所需的最小依赖；content 与 modules 由宿主装配决定形状。 */
export interface HandlerContextOptions {
  readonly auth: AuthContext;
  readonly tx: TransactionWorldTx;
  readonly modules: unknown;
  readonly content: unknown;
  readonly approvedSpeech: ApprovedSpeechReader;
  readonly host: HostServices;
  /** 当前 run 的随机种子；给出时作为 host.rng 的第一个参数，规则模块只传语义字段。 */
  readonly runSeed?: string;
}

/** 构造处理器上下文；rng 只把语义字段交给宿主，不自行生成种子。 */
export function createHandlerContext(options: HandlerContextOptions): HandlerContext<unknown, unknown> {
  return {
    auth: options.auth,
    tx: options.tx,
    modules: options.modules,
    approvedSpeech: options.approvedSpeech,
    content: options.content,
    rng: (...seedParts) =>
      options.runSeed === undefined
        ? options.host.rng(...seedParts)
        : options.host.rng(options.runSeed, ...seedParts),
    ids: (prefix) => options.host.ids(prefix),
  };
}

/** 未装配对白索引时的只读空实现；speech.commit 会得到 not-approved 而不是伪造正文。 */
export const emptyApprovedSpeechReader: ApprovedSpeechReader = {
  read: () => null,
};
