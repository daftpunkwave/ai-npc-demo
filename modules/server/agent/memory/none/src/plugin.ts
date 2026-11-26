/**
 * 实现只推进水位、不保存长期记录的 memory.none 策略。
 * 只依赖 MemoryPort 与模块生命周期辅助。
 * 禁止保存长期记录、创建整理任务或推断隐藏历史。
 */
import type { ModuleCreateInput, ModuleInstance } from "@world-prism/contracts";
import { createStatelessModule, type MemoryPort } from "@world-prism/module-sdk";

class NoneMemoryPort implements MemoryPort {
  prepareIngest(
    input: Parameters<MemoryPort["prepareIngest"]>[0],
  ): ReturnType<MemoryPort["prepareIngest"]> {
    const through = input.observations.reduce(
      (highest, observation) => Math.max(highest, observation.observationSeq),
      0,
    );
    return {
      baseRevision: input.baseRevision,
      observationSeqThrough: through,
      inserts: [],
      retires: [],
      derivedThroughSeq: through,
      derivedThroughTick: input.worldTick,
      changeKind: "ingest",
    };
  }

  retrieve(
    query: Parameters<MemoryPort["retrieve"]>[0],
  ): ReturnType<MemoryPort["retrieve"]> {
    return {
      status: "empty-by-design",
      revision: query.revision,
      coreBlock: null,
      relationSummary: [],
      items: [],
      candidates: 0,
      dropped: [],
    };
  }

  planMaintenance(): ReturnType<MemoryPort["planMaintenance"]> {
    return null;
  }

  async runMaintenance(
    task: Parameters<MemoryPort["runMaintenance"]>[0],
  ): ReturnType<MemoryPort["runMaintenance"]> {
    return {
      baseRevision: task.baseRevision,
      observationSeqThrough: task.observationSeqThrough,
      inserts: [],
      retires: [],
      derivedThroughSeq: task.observationSeqThrough,
      derivedThroughTick: task.dueTick,
      changeKind: "maintenance",
    };
  }

  recordUse(
    input: Parameters<MemoryPort["recordUse"]>[0],
  ): ReturnType<MemoryPort["recordUse"]> {
    return {
      baseRevision: input.baseRevision,
      observationSeqThrough: input.inputObservations.reduce(
        (highest, observation) => Math.max(highest, observation.observationSeq),
        0,
      ),
      inserts: [],
      retires: [],
      derivedThroughSeq: null,
      derivedThroughTick: null,
      changeKind: "use",
    };
  }

  proposeWakeups(): ReturnType<MemoryPort["proposeWakeups"]> {
    return [];
  }
}

export function createMemoryNoneModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  return createStatelessModule(input, new NoneMemoryPort());
}
