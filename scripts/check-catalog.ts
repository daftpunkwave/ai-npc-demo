/**
 * 校验 server 组合根与装配文件：模块 ID 唯一、装配 schema 合法、绑定指向已登记模块、能力与 realm 匹配。
 * 通过包公开入口加载组合根，避免依赖构建产物。
 * 禁止启动服务、打开存储或修改任何模块。
 */
import { readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { parse } from "yaml";
import { assemblyDescriptorSchema } from "@ai-npc/contracts";
import { serverModuleDefinitions } from "@ai-npc/app-server";

const definitions = serverModuleDefinitions;
const byId = new Map<string, (typeof definitions)[number]>();
for (const definition of definitions) {
  if (byId.has(definition.id)) {
    throw new Error(`重复模块 ID: ${definition.id}`);
  }
  byId.set(definition.id, definition);
}

const assemblyRoot = realpathSync("config/assemblies");
const assemblyFiles = [
  {
    name: "local-slg-standard-v1.yaml",
    resolved: realpathSync("config/assemblies/local-slg-standard-v1.yaml"),
    text: readFileSync("config/assemblies/local-slg-standard-v1.yaml", "utf8"),
  },
  {
    name: "local-slg-escalating-v1.yaml",
    resolved: realpathSync("config/assemblies/local-slg-escalating-v1.yaml"),
    text: readFileSync("config/assemblies/local-slg-escalating-v1.yaml", "utf8"),
  },
];

for (const file of assemblyFiles) {
  if (!file.resolved.startsWith(`${assemblyRoot}${sep}`)) {
    throw new Error(`装配文件越出目录: ${file.name}`);
  }
  const assembly = assemblyDescriptorSchema.parse(parse(file.text));
  const realms = [
    ["server", assembly.realms.server],
    ["client", assembly.realms.client],
    ["console", assembly.realms.console],
  ] as const;
  for (const [realmName, realm] of realms) {
    for (const binding of realm.bindings) {
      const definition = byId.get(binding.moduleId);
      if (definition === undefined) {
        throw new Error(`装配 ${file.name} 引用了未登记模块 ${binding.moduleId}`);
      }
      if (definition.realm !== realmName) {
        throw new Error(`装配 ${file.name} 在 ${realmName} 绑定了 ${definition.realm} 模块 ${binding.moduleId}`);
      }
      if (!definition.provides.some((provided) => provided.capability === binding.capability)) {
        throw new Error(`装配 ${file.name} 把 ${binding.moduleId} 绑定到其未提供的能力 ${binding.capability}`);
      }
      if (binding.configRef !== null && !(binding.configRef in assembly.configs)) {
        throw new Error(`装配 ${file.name} 引用了缺失配置块 ${binding.configRef}`);
      }
    }
  }
}
console.info(`catalog ok: ${definitions.length} modules`);
