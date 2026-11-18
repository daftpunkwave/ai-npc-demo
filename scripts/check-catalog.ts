/**
 * 校验 server 组合根与装配文件：模块 ID 唯一、装配 schema 合法、绑定指向已登记模块与配置块。
 * 通过包公开入口加载组合根，避免依赖构建产物。
 * 禁止启动服务、打开存储或修改任何模块。
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { assemblyDescriptorSchema } from "@ai-npc/contracts";
import { serverModuleDefinitions } from "@ai-npc/app-server";

const definitions = serverModuleDefinitions;
const ids = new Set<string>();
for (const definition of definitions) {
  if (ids.has(definition.id)) {
    throw new Error(`重复模块 ID: ${definition.id}`);
  }
  ids.add(definition.id);
}

const assemblyFiles = [
  {
    name: "local-slg-standard-v1.yaml",
    text: readFileSync("config/assemblies/local-slg-standard-v1.yaml", "utf8"),
  },
  {
    name: "local-slg-escalating-v1.yaml",
    text: readFileSync("config/assemblies/local-slg-escalating-v1.yaml", "utf8"),
  },
];

for (const file of assemblyFiles) {
  const assembly = assemblyDescriptorSchema.parse(parse(file.text));
  for (const realm of [assembly.realms.server, assembly.realms.client, assembly.realms.console]) {
    for (const binding of realm.bindings) {
      if (!ids.has(binding.moduleId)) {
        throw new Error(`装配 ${file.name} 引用了未登记模块 ${binding.moduleId}`);
      }
      if (binding.configRef !== null && !(binding.configRef in assembly.configs)) {
        throw new Error(`装配 ${file.name} 引用了缺失配置块 ${binding.configRef}`);
      }
    }
  }
}
console.info(`catalog ok: ${definitions.length} modules`);
