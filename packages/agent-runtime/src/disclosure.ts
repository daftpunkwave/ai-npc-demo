/**
 * 核心职责：按 releasePolicyId 判断资料是否可对目标受众披露。
 * 交互契约：依赖受众、主体派系与证据/秘密持有关系，不读取世界数据库。
 * 约束与禁忌：unknown policy、缺失受众和 private 必须失败关闭。
 */
export interface SpeechFact {
  readonly ref: string;
  readonly releasePolicyId: string;
  readonly summaryZh: string;
}

export interface DisclosureContext {
  readonly audience: readonly string[];
  readonly principalFactions: ReadonlyMap<string, string>;
  readonly heldEvidenceIds: ReadonlyMap<string, ReadonlySet<string>>;
}

export function isDisclosable(policyId: string, context: DisclosureContext): boolean {
  if (context.audience.length === 0) return false;
  if (policyId === "public") return true;
  if (policyId === "private" || policyId.startsWith("private:")) return false;
  if (policyId.startsWith("parties:")) {
    const parties = new Set(policyId.slice("parties:".length).split(",").filter((value) => value.length > 0));
    return context.audience.every((principalId) => parties.has(principalId));
  }
  if (policyId.startsWith("faction:")) {
    const factionId = policyId.slice("faction:".length);
    return context.audience.every((principalId) => context.principalFactions.get(principalId) === factionId);
  }
  if (policyId.startsWith("holders:")) {
    const evidenceId = policyId.slice("holders:".length);
    return context.audience.every((principalId) => context.heldEvidenceIds.get(principalId)?.has(evidenceId) ?? false);
  }
  return false;
}

export function filterDisclosableFacts(
  facts: readonly SpeechFact[],
  requestedRefs: readonly string[],
  context: DisclosureContext,
): { readonly visible: readonly SpeechFact[]; readonly omitted: readonly SpeechFact[] } {
  const refs = new Set(requestedRefs);
  const selected = facts.filter((fact) => refs.has(fact.ref));
  return {
    visible: selected.filter((fact) => isDisclosable(fact.releasePolicyId, context)),
    omitted: selected.filter((fact) => !isDisclosable(fact.releasePolicyId, context)),
  };
}