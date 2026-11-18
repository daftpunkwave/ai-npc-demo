/**
 * 把 YAML 文本解析为未知值，并把解析错误转换为带来源的加载错误。
 * 依赖 yaml 的 parse；只负责语法层，业务字段由调用方的 zod schema 校验。
 * 禁止在此读取文件、填充默认值或吞掉重复键与多文档错误。
 */
import { parse } from "yaml";
import { LoadingError } from "./errors";

/** 解析单个 YAML 文档；多文档、重复键与非映射根都由 yaml 或调用方 schema 拒绝。 */
export function parseYamlText(text: string, source: string): unknown {
  try {
    return parse(text, { uniqueKeys: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new LoadingError({ code: "yaml", source, message });
  }
}
