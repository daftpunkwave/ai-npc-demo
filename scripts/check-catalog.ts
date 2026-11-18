/**
 * 校验 server 组合根：唯一模块 ID、全部定义可加载、可选装配文件存在性。
 * 通过运行时路径导入组合根，避免依赖构建产物。
 * 禁止启动服务、打开存储或修改任何模块。
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";



const module = await import("@ai-npc/app-server") as {
  readonly serverModuleDefinitions?: readonly { readonly id: string }[];
};
const definitions = module.serverModuleDefinitions;
if (definitions === undefined || definitions.length === 0) {
  throw new Error("server module catalog 未导出 serverModuleDefinitions");
}
const ids = new Set<string>();
for (const definition of definitions) {
  if (ids.has(definition.id)) {
    throw new Error(`重复模块 ID: ${definition.id}`);
  }
  ids.add(definition.id);
}
const assemblyDir = join(process.cwd(), "config/assemblies");
if (existsSync(assemblyDir)) {
  for (const file of readdirSync(assemblyDir).filter((name) => name.endsWith(".yaml"))) {
    const text = await import("node:fs/promises").then(async (fs) => fs.readFile(join(assemblyDir, file), "utf8"));
    if (text.trim().length === 0) {
      throw new Error(`装配文件为空: ${file}`);
    }
  }
}
console.info(`catalog ok: ${definitions.length} modules`);
