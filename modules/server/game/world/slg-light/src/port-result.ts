/**
 * 核心职责：定义世界端口操作的成败结果类型与失败构造。
 * 交互契约：全部写操作共用同一结果词表；失败只携带原因码。
 * 约束与禁忌：禁止携带附加负载或吞掉失败原因。
 */
import type { ReasonCode } from "@world-prism/contracts";

export type OpFailure = { readonly ok: false; readonly reasonCode: ReasonCode };
export type OpSuccess = { readonly ok: true };

export function failure(reasonCode: ReasonCode): OpFailure {
  return { ok: false, reasonCode };
}
