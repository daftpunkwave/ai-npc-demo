/**
 * 校验模块状态版本与迁移路径的一致性：无状态模块不得声明迁移，有状态模块必须有连续的版本链。
 * 依赖本包描述符校验原语；只做静态声明检查，不读取或迁移任何真实状态。
 * 禁止接受跳跃、成环、超出当前版本或不属于版本链的迁移路径。
 */
import { descriptorFailure } from "./descriptor-constraints";

interface MigrationPathCandidate {
  readonly toVersion: number;
}

export function validateStateSchemaVersion(moduleId: string, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    descriptorFailure(
      "assembly-incompatible",
      moduleId,
      "stateSchemaVersion",
      "必须是 null（无状态）或正安全整数",
    );
  }
  return value;
}

/**
 * 校验迁移路径与 stateSchemaVersion 一致：
 * 无状态模块不得声明迁移；有状态模块必须存在一条从版本 1 连续到当前版本、且没有多余分支的迁移链。
 */
export function validateMigrationPaths(
  moduleId: string,
  stateSchemaVersion: number | null,
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "必须是迁移路径数组");
  }
  const paths = new Map<number, MigrationPathCandidate>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "每个迁移路径必须是对象");
    }
    const path = item as { readonly fromVersion?: unknown; readonly toVersion?: unknown; readonly migrate?: unknown };
    const fromVersion = path.fromVersion;
    const toVersion = path.toVersion;
    if (typeof fromVersion !== "number" || !Number.isSafeInteger(fromVersion) || fromVersion <= 0) {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "fromVersion 必须是正安全整数");
    }
    if (typeof toVersion !== "number" || !Number.isSafeInteger(toVersion) || toVersion <= 0) {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "toVersion 必须是正安全整数");
    }
    if (fromVersion >= toVersion) {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "fromVersion 必须小于 toVersion");
    }
    if (typeof path.migrate !== "function") {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "migrate 必须是同步函数");
    }
    if (paths.has(fromVersion)) {
      descriptorFailure(
        "assembly-incompatible",
        moduleId,
        "migrationPaths",
        `存在多条从版本 ${fromVersion} 出发的迁移路径`,
      );
    }
    paths.set(fromVersion, { toVersion });
  }

  if (stateSchemaVersion === null) {
    if (paths.size > 0) {
      descriptorFailure(
        "assembly-incompatible",
        moduleId,
        "migrationPaths",
        "无状态模块（stateSchemaVersion 为 null）不能声明迁移路径",
      );
    }
    return;
  }
  for (const [fromVersion, path] of paths) {
    if (path.toVersion > stateSchemaVersion) {
      descriptorFailure(
        "assembly-incompatible",
        moduleId,
        "migrationPaths",
        `迁移路径 ${fromVersion} -> ${path.toVersion} 超过 stateSchemaVersion ${stateSchemaVersion}`,
      );
    }
  }
  const visited = new Set<number>();
  let cursor = 1;
  while (cursor < stateSchemaVersion) {
    const next = paths.get(cursor);
    if (next === undefined) {
      descriptorFailure(
        "assembly-incompatible",
        moduleId,
        "migrationPaths",
        `stateSchemaVersion 为 ${stateSchemaVersion}，但缺少从版本 ${cursor} 开始的迁移路径`,
      );
    }
    if (visited.has(cursor)) {
      descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "迁移路径成环");
    }
    visited.add(cursor);
    cursor = next.toVersion;
  }
  if (visited.size !== paths.size) {
    descriptorFailure("assembly-incompatible", moduleId, "migrationPaths", "存在不属于版本链的迁移路径");
  }
}
