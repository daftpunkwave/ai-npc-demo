/**
 * 提供内容交叉检查共用的失败抛出与 ID 唯一性辅助。
 * 依赖加载错误类型；只服务于内容索引构建与引用检查。
 * 禁止在此修补缺失引用或返回部分结果。
 */
import { LoadingError } from "../../loading/errors";

/** 交叉检查失败统一抛出带文件与字段路径的加载错误。 */
export function fail(source: string, path: string, message: string): never {
  throw new LoadingError({ code: "cross-check", source, path, message });
}

/** 按 ID 建立映射并拒绝同一集合内的重复 ID。 */
export function uniqueById<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  source: string,
  pathOf: (index: number) => string,
): Map<string, T> {
  const map = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    const id = idOf(item);
    if (map.has(id)) {
      fail(source, pathOf(index), `重复的 ID「${id}」`);
    }
    map.set(id, item);
  }
  return map;
}

/** 跨集合登记 ID，拒绝同一 ID 出现在不同内容对象上。 */
export function registerGlobalIds(
  entries: readonly { readonly id: string; readonly source: string; readonly path: string }[],
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const previous = seen.get(entry.id);
    if (previous !== undefined) {
      fail(entry.source, entry.path, `ID「${entry.id}」已被 ${previous} 使用`);
    }
    seen.set(entry.id, `${entry.source}:${entry.path}`);
  }
}
