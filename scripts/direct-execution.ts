/**
 * 核心职责：判定当前模块是否被 Node 作为脚本直接执行，供各 CLI 入口复用同一判定口径。
 * 交互契约：输入模块自身的 import.meta.url；与 process.argv[1] 入口文件的 realpath 比较，命中返回 true。
 * 约束与禁忌：只做执行判定，不承载任何检查逻辑、输出行为或退出码设置。
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 入口路径取 argv[1] 并按空串统一判空；realpath 不一致或不存在时回退为路径字符串比较。 */
export function isDirectExecution(moduleUrl: string): boolean {
  const entryPath = process.argv[1] ?? "";
  if (entryPath.length === 0) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 只比较仓库内固定入口文件的 realpath，不是外部路径。
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}
