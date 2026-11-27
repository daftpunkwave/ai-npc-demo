/**
 * 核心职责：锁定 module-sdk 对描述符校验的兼容导出：校验实现已下沉到 kernel，模块作者仍可从 module-sdk 导入。
 * 交互契约：比较 module-sdk 与 kernel 导出的对象身份，确保两处是同一份实现而不是各自维护的副本。
 * 约束与禁忌：不复述校验规则本身，规则由 kernel 的测试覆盖。
 */
import { describe, expect, it } from "vitest";
import { REALM_NAMESPACES as kernelRealmNamespaces, validateModuleDefinition as kernelValidate } from "@world-prism/kernel";
import { REALM_NAMESPACES, validateModuleDefinition } from "../src/index";

describe("module-sdk 的描述符校验兼容导出", () => {
  it("validateModuleDefinition 与 REALM_NAMESPACES 就是 kernel 的同一份实现", () => {
    expect(validateModuleDefinition).toBe(kernelValidate);
    expect(REALM_NAMESPACES).toBe(kernelRealmNamespaces);
  });
});
