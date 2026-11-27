/**
 * 核心职责：账本检索的选择状态：按记忆 ID 挑选已评分条目，按来源观察去重、按 token 预算裁剪，并记录落选原因。
 * 交互契约：调用方按「必带项 → 候选窗口 → 其余记为 rank」的顺序驱动；挑选顺序即输出顺序。
 * 约束与禁忌：只操作传入的已评分条目，不读取存储、不重新评分；落选明细按 memoryId 幂等且有条数上限；
 *   来源去重键只在条目进入必带或候选阶段时计算，未进入的记录不承担排序与拼接开销。
 */
import { estimateTokens, type MemoryBundle } from "@world-prism/contracts";
import type { MemoryRecordView } from "@world-prism/module-sdk";
import { compareStrings } from "./ledger-model";

/** 已按检索分数排序的候选记录。 */
export interface ScoredRecord {
  readonly record: MemoryRecordView;
  readonly score: number;
}

/** 已挑中的条目；mustInclude 区分必带项与按分数入选的候选。 */
export interface PickedRecord extends ScoredRecord {
  readonly mustInclude: boolean;
}

type DropReason = MemoryBundle["dropped"][number]["reason"];

/** 一次检索的条目上限、token 预算与落选明细上限。 */
export interface RecallLimits {
  readonly maxItems: number;
  readonly maxTokens: number;
  /** 落选明细是解释性样本而非完整清单：上限取候选窗口容量，使对象分配不随历史记忆总量增长。 */
  readonly droppedLimit: number;
}

export class RecallSelection {
  private readonly picked = new Map<string, PickedRecord>();
  private readonly droppedIds = new Set<string>();
  private readonly seenSources = new Set<string>();
  private readonly sourceKeys = new Map<string, string>();
  private readonly droppedSample: MemoryBundle["dropped"][number][] = [];
  private tokenEstimate = 0;

  constructor(private readonly limits: RecallLimits) {}

  /**
   * 按顺序挑选必带项，直到挑满 quota 条或达到条目上限。
   * 与已挑条目同来源的必带项直接跳过、不记落选；超出 token 预算的记为 budget。
   */
  pickMandatory(items: readonly ScoredRecord[], quota: number): void {
    let selected = 0;
    for (const item of items) {
      if (selected >= quota || this.picked.size >= this.limits.maxItems) break;
      if (this.tryPick(item, true)) selected += 1;
    }
  }

  /**
   * 按分数顺序从候选窗口补足到 capacity 条；已挑条目跳过，同来源的记为 dedupe，超出 token 预算的记为 budget。
   */
  fillFrom(pool: readonly ScoredRecord[], capacity: number): void {
    for (const item of pool) {
      if (this.picked.size >= capacity) break;
      if (this.picked.has(item.record.memoryId)) continue;
      this.tryPick(item, false);
    }
  }

  /** 把既未挑中、也未记过落选原因的条目记为 rank。 */
  markUnpickedAsRank(scored: readonly ScoredRecord[]): void {
    for (const { record } of scored) {
      if (!this.picked.has(record.memoryId) && !this.droppedIds.has(record.memoryId)) {
        this.markDropped(record.memoryId, "rank");
      }
    }
  }

  /** 按挑选顺序返回已挑条目。 */
  pickedRecords(): readonly PickedRecord[] {
    return [...this.picked.values()];
  }

  /** 落选明细样本，条数不超过 droppedLimit。 */
  dropped(): MemoryBundle["dropped"] {
    return this.droppedSample;
  }

  private tryPick(item: ScoredRecord, mustInclude: boolean): boolean {
    const { memoryId } = item.record;
    if (this.picked.has(memoryId)) return false;
    const sourceKey = this.sourceKeyOf(item.record);
    if (sourceKey.length > 0 && this.seenSources.has(sourceKey)) {
      // 必带项遇到同来源时让位给已挑条目，不算落选；候选阶段的同来源条目记为 dedupe。
      if (!mustInclude) this.markDropped(memoryId, "dedupe");
      return false;
    }
    const itemTokens = estimateTokens(item.record.content.summaryZh);
    if (this.tokenEstimate + itemTokens > this.limits.maxTokens) {
      this.markDropped(memoryId, "budget");
      return false;
    }
    if (sourceKey.length > 0) this.seenSources.add(sourceKey);
    this.tokenEstimate += itemTokens;
    this.picked.set(memoryId, { ...item, mustInclude });
    return true;
  }

  /** 同一记忆可能先在必带阶段因预算落选、又在候选窗口被判一次落选，按 memoryId 幂等只记首次原因。 */
  private markDropped(memoryId: string, reason: DropReason): void {
    if (this.droppedIds.has(memoryId)) return;
    this.droppedIds.add(memoryId);
    if (this.droppedSample.length < this.limits.droppedLimit) this.droppedSample.push({ memoryId, reason });
  }

  private sourceKeyOf(record: MemoryRecordView): string {
    let key = this.sourceKeys.get(record.memoryId);
    if (key === undefined) {
      key = record.sourceObservationIds.slice().sort(compareStrings).join(",");
      this.sourceKeys.set(record.memoryId, key);
    }
    return key;
  }
}
