/**
 * 装配期文档缓存的类型与分层索引：把「引用 → 文件路径」与已解析文档限制在一次启动或预检内。
 * 依赖配置加载结果的形状；不解析文档、不读磁盘。
 * 禁止把缓存提升为跨请求的模块级单例，否则配置变更不再生效。
 */

/** 已解析的配置文档；值与来源由加载器填入。 */
export interface LoadedConfigDocument<T> {
  readonly configRef: string;
  readonly source: string;
  readonly value: T;
}

/**
 * 装配期文档缓存。文档按「schema → 种类 → transform → env 解析开关 → 引用」逐级索引：
 * 仅用引用作键会让同名不同种类的文档互相覆盖。
 */
export interface ConfigDocumentCache {
  readonly fileIndex: Map<string, readonly string[]>;
  readonly documents: Map<
    unknown,
    Map<string, Map<unknown, Map<boolean, Map<string, LoadedConfigDocument<unknown>>>>>
  >;
}

/** 新建一份装配期缓存；调用方为一次启动、一次预检或一次测试装配各建一份。 */
export function createConfigDocumentCache(): ConfigDocumentCache {
  return { fileIndex: new Map(), documents: new Map() };
}

/** 一次解析的定位条件：schema、草稿种类、transform 与 env 解析开关共同决定缓存槽位。 */
export interface DocumentCacheSlotKey {
  readonly schema: unknown;
  readonly draftKind: string | undefined;
  readonly transform: unknown;
  readonly resolveEnv: boolean;
}

/** 取一份缓存槽位；缓存缺失时返回 undefined，调用方不做缓存。 */
export function documentCacheSlot(
  cache: ConfigDocumentCache | undefined,
  key: DocumentCacheSlotKey,
): Map<string, LoadedConfigDocument<unknown>> | undefined {
  const documents = cache?.documents;
  if (documents === undefined) {
    return undefined;
  }
  type ByEnv = Map<boolean, Map<string, LoadedConfigDocument<unknown>>>;
  type ByTransform = Map<unknown, ByEnv>;
  const byKind = documents.get(key.schema) ?? new Map<string, ByTransform>();
  documents.set(key.schema, byKind);
  const kindKey = key.draftKind ?? "";
  const byTransform = byKind.get(kindKey) ?? new Map<unknown, ByEnv>();
  byKind.set(kindKey, byTransform);
  const transformKey: unknown = key.transform ?? null;
  const byEnv = byTransform.get(transformKey) ?? new Map<boolean, Map<string, LoadedConfigDocument<unknown>>>();
  byTransform.set(transformKey, byEnv);
  const byRef = byEnv.get(key.resolveEnv) ?? new Map<string, LoadedConfigDocument<unknown>>();
  byEnv.set(key.resolveEnv, byRef);
  return byRef;
}
