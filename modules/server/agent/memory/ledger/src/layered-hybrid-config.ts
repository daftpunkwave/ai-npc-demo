/**
 * 核心职责：从模块描述符入口转出分层混合配置，并映射复用的 M1 公共层参数。
 * 交互契约：只把已校验的混合配置投影为账本 schema，不读取身份或 revision。
 * 约束与禁忌：禁止复制默认值、执行检索或持久化。
 */
import {
  layeredHybridConfigSchema,
  layeredHybridDefaults,
  ledgerConfigSchema,
  type LayeredHybridConfig,
  type LedgerConfig,
} from "./definition";

export { layeredHybridConfigSchema, layeredHybridDefaults, type LayeredHybridConfig };

/** 去掉混合层专属参数，复用结构化账本的 L1、L2、L4 与每日规则。 */
export function ledgerConfigFromHybrid(config: LayeredHybridConfig): LedgerConfig {
  return ledgerConfigSchema.parse({
    capacity: {
      short: config.capacity.short,
      long: config.capacity.long,
      core: config.capacity.core,
    },
    salienceThresholds: config.salienceThresholds,
    decayBaseTicks: config.decayBaseTicks,
    relationModifiersPerTarget: config.relationModifiersPerTarget,
    recall: {
      mustIncludeProspective: config.recall.mustIncludeProspective,
      mustIncludeAboutCounterpart: config.recall.mustIncludeAboutCounterpart,
      topK: config.recall.topK,
      candidateLimit: config.recall.candidateLimit,
      weights: config.recall.weights,
    },
    relationInput: config.relationInput,
    prospectiveInput: config.prospectiveInput,
    wakeups: config.wakeups,
    reinforcement: config.reinforcement,
    maintenanceTrigger: config.maintenanceTrigger,
  });
}