/**
 * 汇总模块描述符的身份、类别、realm 命名空间与各字段校验，形成唯一的静态预检入口。
 * 依赖本包字段校验原语与迁移路径校验，以及公共契约的模块/能力 schema；不加载实现或创建资源。
 * 禁止跳过任一字段的校验，也禁止在校验失败后返回部分描述符。
 */
/* eslint-disable xss/no-mixed-html -- descriptorFailure 的 <未知 ID> 与字段名只是诊断占位符，不参与 HTML 输出。 */
import {
  instanceScopeSchema,
  moduleIdSchema,
  moduleKindSchema,
  realmSchema,
  type ModuleDefinition,
} from "@world-prism/contracts";
import {
  REALM_NAMESPACES,
  descriptorFailure,
  isStrictConfigSchema,
  leadingNamespace,
  requireNonEmptyString,
  validateCapabilityRefs,
  validateContributions,
  validateDefaults,
  validateExperimentAxes,
  validateOwnsAggregates,
  validateRemoteCapabilities,
} from "./descriptor-constraints";
import { validateMigrationPaths, validateStateSchemaVersion } from "./migration-paths";

/** 校验一个模块描述符的全部必填字段与明显非法组合；通过后不修改描述符。 */
export function validateModuleDefinition(definition: ModuleDefinition): void {
  const descriptor = definition as unknown as { readonly [key: string]: unknown };
  const idResult = moduleIdSchema.safeParse(descriptor["id"]);
  if (!idResult.success) {
    const rawId = typeof descriptor["id"] === "string" ? descriptor["id"] : null;
    descriptorFailure(
      "assembly-incompatible",
      rawId,
      "id",
      "必须是 <group>.<family>.<impl> 形式且各段为小写标识符",
    );
  }
  const moduleId = idResult.data;

  const realmResult = realmSchema.safeParse(descriptor["realm"]);
  if (!realmResult.success) {
    descriptorFailure("assembly-incompatible", moduleId, "realm", "必须是 server、client 或 console");
  }
  const realm = realmResult.data;
  // eslint-disable-next-line security/detect-object-injection -- realm 来自 zod 受限枚举。
  const namespaces = REALM_NAMESPACES[realm];
  if (!namespaces.includes(leadingNamespace(moduleId))) {
    descriptorFailure(
      "realm-violation",
      moduleId,
      "id",
      `${realm} realm 的模块 ID 必须以 ${namespaces.join(" / ")} 开头`,
    );
  }

  if (!moduleKindSchema.safeParse(descriptor["kind"]).success) {
    descriptorFailure("assembly-incompatible", moduleId, "kind", "必须是 service、contributor 或 adapter");
  }
  if (!instanceScopeSchema.safeParse(descriptor["instanceScope"]).success) {
    descriptorFailure(
      "assembly-incompatible",
      moduleId,
      "instanceScope",
      "必须是 deployment、run、branch、agent 或 session",
    );
  }
  requireNonEmptyString(moduleId, "version", descriptor["version"]);
  requireNonEmptyString(moduleId, "apiVersion", descriptor["apiVersion"]);

  validateCapabilityRefs(moduleId, realm, "provides", descriptor["provides"]);
  validateCapabilityRefs(moduleId, realm, "requires", descriptor["requires"]);
  validateRemoteCapabilities(moduleId, realm, descriptor["requiresRemote"]);

  if (!isStrictConfigSchema(descriptor["configSchema"])) {
    descriptorFailure(
      "assembly-incompatible",
      moduleId,
      "configSchema",
      "必须是调用过 strict 的 Zod object schema，未知键必须被拒绝",
    );
  }
  const stateSchemaVersion = validateStateSchemaVersion(moduleId, descriptor["stateSchemaVersion"]);
  validateMigrationPaths(moduleId, stateSchemaVersion, descriptor["migrationPaths"]);

  if (typeof descriptor["create"] !== "function") {
    descriptorFailure("assembly-incompatible", moduleId, "create", "必须是返回模块实例的工厂函数");
  }

  validateDefaults(moduleId, descriptor["defaults"]);
  validateOwnsAggregates(moduleId, realm, descriptor["ownsAggregates"]);
  validateContributions(moduleId, descriptor["contributions"]);
  validateExperimentAxes(moduleId, descriptor["experimentAxes"]);
}
