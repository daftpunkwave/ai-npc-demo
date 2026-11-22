/**
 * 从已校验内容中提取记忆策略所需的最小身份上下文。
 * 依赖内容包索引的人物与 locale 词条。
 * 禁止向记忆模块暴露密钥、prompt 或可变内容对象。
 */
import type { MemoryAgentIdentity } from "@ai-npc/module-sdk";
import type { ContentPack } from "@ai-npc/experiment";

export function memoryIdentityForAgent(
  content: ContentPack,
  agentId: string,
): MemoryAgentIdentity {
  const character = content.index.characters.get(agentId);
  const faction = content.index.factions.get(agentId);
  const persona = character ?? faction?.persona;
  if (persona === undefined) {
    throw new Error(`content has no persona for agent ${agentId}`);
  }
  const initialRelations = character !== undefined
    ? character.initialRelations.map(({ targetId, trust }) => ({ targetId, trust }))
    : (faction?.relations ?? []).map(({ targetId, trust }) => ({ targetId, trust }));
  return {
    factionId: character?.factionId ?? faction?.factionId ?? agentId,
    values: [...persona.values],
    initialRelations,
    personalityKeywords: content.locale.lexicons.personalityKeywords,
  };
}
