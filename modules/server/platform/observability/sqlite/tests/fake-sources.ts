/**
 * 核心职责：为观测模块测试构造进程内的数据源端口与不可访问的存储端口。
 * 交互契约：数据源只实现用例给出的读取方法并记录每次 read 调用；未给出的方法与存储访问一律抛错，
 *   用来证明被测查询只经数据源端口取数，不依赖任何表结构。
 * 约束与禁忌：不打开 SQLite，不模拟 SQL；不得在此放入业务断言。
 */
import type { DebugWakeInput, StoragePort } from "@world-prism/contracts";
import type { ObservabilitySourceReader, ObservabilitySources, ObservedArtifactBody } from "@world-prism/module-sdk";

export interface FakeSources extends ObservabilitySources {
  /** read 回调被调用的次数。 */
  readonly reads: () => number;
  readonly wakes: readonly DebugWakeInput[];
}

export function fakeSources(
  reader: Partial<ObservabilitySourceReader>,
  artifacts?: ReadonlyMap<string, ObservedArtifactBody>,
): FakeSources {
  let reads = 0;
  const wakes: DebugWakeInput[] = [];
  const strictReader = new Proxy(reader, {
    get(target, property: string) {
      const method = target[property as keyof ObservabilitySourceReader];
      if (method === undefined) throw new Error(`用例没有为数据源提供 ${property}`);
      return method;
    },
  }) as ObservabilitySourceReader;
  return {
    reads: () => reads,
    wakes,
    read: (query) => {
      reads += 1;
      return query(strictReader);
    },
    artifactBody: (artifactId) => {
      if (artifacts === undefined) throw new Error("用例没有为数据源提供 artifactBody");
      return artifacts.get(artifactId) ?? null;
    },
    requestDebugWake: (input) => {
      wakes.push(input);
    },
  };
}

/** 任何访问都失败的存储端口：被测查询若绕过数据源直接读表会立刻暴露。 */
export function inaccessibleStorage(): StoragePort {
  return new Proxy({}, {
    get(_target, property: string) {
      throw new Error(`观测查询不应直接访问存储：${property}`);
    },
  }) as StoragePort;
}
