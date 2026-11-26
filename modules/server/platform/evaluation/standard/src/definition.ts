/**
 * 核心职责：声明评估计分能力，向宿主提供探针计分、指标聚合与报告组装端口。
 * 交互契约：输入端由宿主注入（探针执行结果、run 有效性与成本快照）；模块自身不读存储、
 * 不启动实验、不创建分支、不调用模型。
 * 约束与禁忌：禁止在模块内推进时钟或写入世界状态；计分只按脚本冻结的 answerKey 做词面判定。
 *
 * 实例作用域为部署级：评估端口无状态，同一部署内所有 run 的报告由同一实例组装，
 * 而 run 级实例会随分支切换反复创建，反而让计分口径分散在多份实例里。
 * 因此本模块不声明平台存储依赖：读取探针与 run 记录是宿主的职责。
 */
import { capabilityIdSchema, emptyModuleConfigSchema, type ModuleDefinition } from "@world-prism/contracts";
import { defineModule } from "@world-prism/module-sdk";

export const evaluationModuleDefinition: ModuleDefinition = defineModule({
  id: "platform.evaluation.standard",
  realm: "server",
  kind: "service",
  version: "1.0.0",
  apiVersion: "1",
  instanceScope: "deployment",
  provides: [
    {
      capability: capabilityIdSchema.parse("platform.evaluation"),
      cardinality: "exactly-one",
      instanceScope: "deployment",
    },
  ],
  requires: [],
  requiresRemote: [],
  configSchema: emptyModuleConfigSchema,
  defaults: {},
  stateSchemaVersion: null,
  migrationPaths: [],
  create: async (input) => (await import("./plugin")).createEvaluationModule(input),
});
