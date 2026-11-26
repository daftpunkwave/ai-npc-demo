/**
 * 汇总标准协议模块的公开入口：定义、端口工厂、规则贡献与状态读取。
 * 依赖定义、端口、处理器与状态文件；宿主只经组合根登记定义。
 * 禁止在这里打开存储或执行协议状态迁移。
 */
export const packageName = "@world-prism/mod-game-agreements-standard";

export { agreementsModuleDefinition } from "./definition";
export { createAgreementsContributor } from "./contributor";
export { createAgreementsPort } from "./port";
export { agreementStateSchema, readAgreementState } from "./state";
export type { AgreementState } from "./state";
