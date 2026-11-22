/**
 * 核心职责：资产校验 CLI 的执行入口，聚合校验器与 CLI 的公开导出面。
 * 交互契约：直接执行时以仓库根为基准校验 assets/ 与内容包，违规时以非零状态退出。
 * 约束与禁忌：校验规则与输出实现位于 asset-check/ 域文件，入口不承载具体校验逻辑。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution, runAssetCheckCli } from "./asset-check/cli";

export { checkAssets } from "./asset-check/checker";
export { runAssetCheckCli } from "./asset-check/cli";
export type {
  AssetCheckOptions,
  AssetCheckReport,
  AssetCliOptions,
  AssetViolation,
} from "./asset-check/report-types";

if (isDirectExecution(import.meta.url)) {
  process.exitCode = runAssetCheckCli({ root: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
}
