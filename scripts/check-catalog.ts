/**
 * catalog 预检脚本入口：调用服务端组合根的装配目录预检，并在直接执行时输出结果与退出码。
 * 依赖 app-server 公开的目录扫描与 kernel 解析预检；不启动服务、不打开存储。
 * 禁止在这里写死装配文件、放宽校验或吞掉失败项。
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCatalogCheckCli } from "@ai-npc/app-server";

export { checkCatalog, runCatalogCheckCli } from "@ai-npc/app-server";
export type {
  CatalogCheckOptions,
  CatalogCheckReport,
  CatalogCliOptions,
  CatalogViolation,
} from "@ai-npc/app-server";

function isDirectExecution(moduleUrl: string): boolean {
  const entryPath = process.argv[1] ?? "";
  if (entryPath.length === 0) {
    return false;
  }
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(resolve(entryPath)) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = runCatalogCheckCli({ root: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
}
