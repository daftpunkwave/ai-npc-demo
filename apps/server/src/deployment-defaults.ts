/**
 * 核心职责：部署缺省引用的单一来源：装配、模型布局、名册与内容包。
 * 交互契约：环境变量与宿主启动参数未指定时，部署配置解析、宿主启动、装配解析与目录预检都从这里取值。
 * 约束与禁忌：只放引用 ID，不读取文件、不做解析；修改缺省值只改这里，不在调用方另写字面量。
 */

/** 未指定时使用的部署引用。 */
export const deploymentDefaults = {
  assemblyRef: "local-slg-standard-v1",
  modelLayoutRef: "shared-model-layout-v1",
  rosterRef: "standard-15",
  contentPackId: "earth-2964-v1",
} as const;

/**
 * 个别装配的模型布局缺省：确定性测试装配不访问真实模型，未登记的装配使用 deploymentDefaults.modelLayoutRef。
 */
const modelLayoutByAssembly: Readonly<Record<string, string>> = {
  "local-slg-test-v1": "deterministic-model-layout-v1",
};

/** 按装配取模型布局缺省；显式配置的模型布局优先，由调用方处理。 */
export function defaultModelLayoutRefFor(assemblyRef: string): string {
  return Object.hasOwn(modelLayoutByAssembly, assemblyRef)
    // eslint-disable-next-line security/detect-object-injection -- 已用 hasOwn 限定为登记表自身的键。
    ? modelLayoutByAssembly[assemblyRef] as string
    : deploymentDefaults.modelLayoutRef;
}
