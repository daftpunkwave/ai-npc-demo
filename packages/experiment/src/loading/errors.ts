/**
 * 定义内容与配置加载失败时携带来源与字段路径的错误类型与格式化辅助。
 * 依赖 zod 的错误类型；为 YAML 解析、schema 校验与交叉检查提供统一的可定位报告。
 * 禁止吞掉原始错误或把含密钥的配置值写入错误消息。
 */
import type { ZodError } from "zod";

/** 加载失败分类：缺文件、多余文件、YAML 解析、schema、引用、环境变量与交叉检查。 */
export type LoadingErrorCode =
  | "missing-file"
  | "unexpected-file"
  | "yaml"
  | "schema"
  | "reference"
  | "env"
  | "cross-check";

/** 加载错误：消息统一为 `<来源>: <字段路径>: <原因>`，便于启动日志直接定位。 */
export class LoadingError extends Error {
  readonly code: LoadingErrorCode;
  readonly source: string;
  readonly path: string;

  constructor(details: {
    readonly code: LoadingErrorCode;
    readonly source: string;
    readonly message: string;
    readonly path?: string;
  }) {
    const path = details.path ?? "";
    super(`${details.source}${path === "" ? "" : `: ${path}`}: ${details.message}`);
    this.name = "LoadingError";
    this.code = details.code;
    this.source = details.source;
    this.path = path;
  }
}

/** 把 zod 的受限路径格式化为点号路径；数组下标保留为 `.0` 形式。 */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

/** 把首个 zod 问题转换为带来源与路径的加载错误；没有问题时退化为通用 schema 错误。 */
export function schemaLoadingError(source: string, error: ZodError): LoadingError {
  const issue = error.issues.at(0);
  if (issue === undefined) {
    return new LoadingError({ code: "schema", source, message: "内容不符合 schema" });
  }
  return new LoadingError({
    code: "schema",
    source,
    path: formatIssuePath(issue.path),
    message: issue.message,
  });
}

/**
 * 构造交叉检查错误。各加载器的交叉校验都要给出「来源 + 字段路径 + 原因」，
 * 统一从这里构造可避免错误码与格式在不同加载器之间逐渐分叉。
 */
export function crossCheckLoadingError(source: string, path: string, message: string): LoadingError {
  return new LoadingError({ code: "cross-check", source, path, message });
}

/** 引用解析错误（找不到文件、同名歧义、ID 与引用不一致）。 */
export function referenceLoadingError(source: string, path: string, message: string): LoadingError {
  return new LoadingError({ code: "reference", source, path, message });
}
