/**
 * 浏览器 realm 的远端能力对账：从装配 server 段取出已绑定能力，并校验浏览器模块的 requiresRemote 都在其中。
 * 依赖公共契约的装配与模块类型及 DomainError；服务端装配解析与浏览器握手共用同一判定与诊断形状。
 * 禁止把未绑定的服务端能力当成可用，也禁止只报告第一个缺口而隐藏同一 realm 中其他模块的缺失。
 */
import { DomainError, type AssemblyDescriptor, type CapabilityId, type ModuleDefinition, type Realm } from "@world-prism/contracts";

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** 装配 server 段绑定的能力 ID，去重后按字典序排列；浏览器 realm 能远程消费的能力只来自这里。 */
export function serverBoundCapabilities(assembly: AssemblyDescriptor): readonly CapabilityId[] {
  return [...new Set(assembly.realms.server.bindings.map((binding) => binding.capability))].sort(compareText);
}

/**
 * 校验浏览器模块声明的 requiresRemote 都在远端能力集合内。
 * 缺失时以 assembly-incompatible 拒绝：页面若照常加载，只会在首个 API 请求时才失败，
 * 研究者看到的是白屏或一直加载，而不是装配不兼容。诊断逐模块列出缺失能力，一次给出全部缺口。
 */
export function assertRemoteCapabilities(
  definitions: readonly Pick<ModuleDefinition, "id" | "requiresRemote">[],
  available: readonly string[],
  realm: Realm,
): void {
  const availableSet = new Set(available);
  const gaps = definitions
    .map((definition) => ({
      moduleId: definition.id,
      missing: definition.requiresRemote.filter((capability) => !availableSet.has(capability)),
    }))
    .filter((gap) => gap.missing.length > 0);
  if (gaps.length === 0) {
    return;
  }
  const summary = gaps.map((gap) => `${gap.moduleId} 缺少 ${gap.missing.join("、")}`).join("；");
  throw new DomainError("assembly-incompatible", `${realm} realm 模块需要的远端能力未由服务端装配绑定：${summary}`, {
    details: { realm, modules: gaps.map((gap) => ({ moduleId: gap.moduleId, missing: [...gap.missing] })) },
  });
}
