/**
 * 核心职责：组装世界模块的端口实现，并承载章节评估与证据发现的受控写入口。
 * 交互契约：依赖查询、实体、委托与指标操作片段及章节结算规则；宿主与模块装配经 createWorldPort 构造端口。
 * 约束与禁忌：章节评估只允许协议 provider 的章节终点时钟步骤或宿主触发；禁止在此写入地图或库存聚合。
 */
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- Codacy 缺少 workspace 类型解析，将导入的泛型类型误判为 any。 */
import { DomainError, type ResourceAmounts } from "@ai-npc/contracts";
import { gameModuleIds, principalsAudience, totalAmount, type AgreementCounts, type GameContent, type GameIdFactory, type GameWorldPort, type ScopedWorldTxFactory } from "@ai-npc/module-sdk";
import { runChapterEvaluation } from "./settlement";
import { campaignAggregateId, metersAggregateId } from "./port-aggregates";
import { createWorldQueries } from "./port-queries";
import { createWorldEntityOps } from "./port-entity-ops";
import { createWorldDelegationOps } from "./port-delegation-ops";
import { createWorldMeterOps } from "./port-meter-ops";
import { failure, type OpFailure, type OpSuccess } from "./port-result";
import {
  evidencePlacementStateSchema,
  readWorldState,
  type EvidencePlacementState,
} from "./state";

export { campaignAggregateId, metersAggregateId };

/** 构造世界端口时生效的规则参数。 */
export interface WorldPortOptions {
  /** 章节长度；到达该长度后的评估由协议模块触发。 */
  readonly chapterLengthTicks: number;
  /** 当前调用方是否被允许触发章节评估：协议 provider 的章节终点时钟步骤或宿主。 */
  readonly allowChapterEvaluation: boolean;
}

/** 直接构造世界端口时的规则参数：章节长度 168，并允许调用方触发评估（测试与宿主直接构造）。 */
const defaultWorldPortOptions: WorldPortOptions = {
  chapterLengthTicks: 168,
  allowChapterEvaluation: true,
};

/** 构造绑定到当前事务的世界端口；章节长度与评估触发权限来自模块配置与调用方身份。 */
export function createWorldPort(
  txFor: ScopedWorldTxFactory,
  content: GameContent,
  ids: GameIdFactory,
  options: WorldPortOptions = defaultWorldPortOptions,
): GameWorldPort {
  const { findDelegations, ...queries } = createWorldQueries({ txFor, content });
  // 章节长度与评估权限在构造时取值；调用方此后修改 options 对象不影响端口行为。
  const { chapterLengthTicks, allowChapterEvaluation } = options;
  const tx = () => txFor(gameModuleIds.world);
  return {
    ...queries,
    ...createWorldEntityOps({ txFor, content }),
    ...createWorldDelegationOps({ txFor, ids, queries: { findDelegations } }),
    ...createWorldMeterOps({ txFor }),

    evaluateChapter(counts: () => AgreementCounts): { readonly stopClock: true } | undefined {
      if (!allowChapterEvaluation) {
        throw new DomainError(
          "forbidden",
          "章节评估只能由协议模块的章节终点时钟步骤或宿主触发",
        );
      }
      return runChapterEvaluation(tx(), counts, content.cityResources, chapterLengthTicks);
    },

    discoverEvidence(input: {
      readonly evidenceId: string;
      readonly discoveredBy: string;
      readonly taskId: string;
    }): OpSuccess | OpFailure {
      const evidence = content.evidence.get(input.evidenceId);
      if (evidence === undefined || evidence.discoverable !== true) {
        return failure("invalid-params");
      }
      const record = readWorldState(
        tx(),
        "evidence-placement",
        input.evidenceId,
        evidencePlacementStateSchema,
      );
      const placement: EvidencePlacementState = record?.state ?? {
        evidenceId: input.evidenceId,
        nodeId: evidence.nodeId ?? null,
        discoveredBy: null,
      };
      if (placement.discoveredBy !== null) {
        return failure("no-change");
      }
      tx().put("evidence-placement", input.evidenceId, {
        ...placement,
        discoveredBy: input.discoveredBy,
      });
      tx().emit(
        "EvidenceDiscovered",
        { evidenceId: input.evidenceId, discoveredBy: input.discoveredBy, taskId: input.taskId },
        [...principalsAudience([input.discoveredBy])],
      );
      return { ok: true };
    },
  };
}

/** 判断资源量是否超过队伍容量，供行动模块与规则测试复用。 */
export function cargoExceedsCapacity(cargo: ResourceAmounts, capacity: number): boolean {
  return totalAmount(cargo) > capacity;
}
