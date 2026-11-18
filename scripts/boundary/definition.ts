/**
 * 规则 2 的子规则：模块定义文件只含描述符数据，不得静态加载实现或适配器依赖。
 * 实现应由 create 中的动态导入加载；动态导入目标不在静态检查范围，正确性留给人工复核。
 * 禁止把该子规则扩展到其他模块源码，或对读不到 kind 的模块跳过检查。
 */
import {
  DEFINITION_FORBIDDEN_EXTERNAL_PREFIXES,
  DEFINITION_FORBIDDEN_EXTERNALS,
  RULE_MODULE_REALM,
} from "./constants";
import { violation } from "./finding";
import { isRelativeSpecifier, packageNameOfSpecifier } from "./paths";
import type { BoundarySourceFile, BoundaryViolation, ImportRecord } from "./types";

/** 模块定义文件固定位于包的 src 目录；路径不匹配时不做子规则判定。 */
export function isModuleDefinitionFile(filePath: string, packageDirectory: string): boolean {
  return filePath === `${packageDirectory}/src/definition.ts`;
}

function isForbiddenDefinitionDependency(packageBase: string): boolean {
  return (
    DEFINITION_FORBIDDEN_EXTERNALS.has(packageBase) ||
    DEFINITION_FORBIDDEN_EXTERNAL_PREFIXES.some((prefix) => packageBase.startsWith(prefix))
  );
}

/** 检查定义文件的静态 import；类型导入不执行目标模块，因此只限制非类型相对导入与禁用第三方库。 */
export function checkDefinitionFileImports(
  file: BoundarySourceFile,
  imports: readonly ImportRecord[],
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const record of imports) {
    if (record.kind === "dynamic" || record.kind === "dynamic-non-literal") {
      continue;
    }
    if (isRelativeSpecifier(record.specifier)) {
      if (record.typeOnly) {
        continue;
      }
      violations.push(
        violation(
          RULE_MODULE_REALM,
          "definition-static-implementation-import",
          file.path,
          record.line,
          "模块定义文件不得静态 import 同包实现文件；实现应由 create 动态加载，目标是否为纯数据文件需人工复核。",
        ),
      );
      continue;
    }
    if (record.specifier.startsWith("@ai-npc/")) {
      continue;
    }
    const packageBase = packageNameOfSpecifier(record.specifier);
    if (isForbiddenDefinitionDependency(packageBase)) {
      violations.push(
        violation(
          RULE_MODULE_REALM,
          "definition-static-forbidden-import",
          file.path,
          record.line,
          `模块定义文件不得静态 import ${packageBase}；定义文件必须能被宿主在 Node 中直接导入。`,
        ),
      );
    }
  }
  return violations;
}
