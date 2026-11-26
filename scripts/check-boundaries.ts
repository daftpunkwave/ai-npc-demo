/**
 * 边界检查公开入口：聚合导出检查函数与类型，并在作为脚本运行时扫描当前仓库。
 * 规则实现按职责放在 boundary 子目录，此处只做导出与 CLI 触发。
 * 禁止在入口重复规则逻辑、放宽子模块判定或修改被检查文件。
 */
import { runCliIfDirectExecution } from "./boundary/cli";

export { checkBoundaries, checkSourceFile } from "./boundary/checker";
export {
  checkSourceFileLengths,
  countSourceLines,
  lengthExemptions,
  SOURCE_FILE_LINE_LIMIT,
} from "./boundary/file-length";
export { checkRepository, scanRepository } from "./boundary/repository";
export { formatViolation } from "./boundary/cli";
export type {
  BoundaryCheckInput,
  BoundaryPackage,
  BoundaryRule,
  BoundarySourceFile,
  BoundaryViolation,
  ModuleKind,
  ModuleKindOverride,
  ModuleRealm,
  SingleFileCheckInput,
} from "./boundary/types";

runCliIfDirectExecution(import.meta.url);
