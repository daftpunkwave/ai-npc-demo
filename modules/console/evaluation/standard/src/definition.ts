/**
 * 核心职责：声明研究员的只读评估页面，展示实验列表、run 报告与「变体 × 脚本分支」汇总。
 * 交互契约：依赖远端的 `platform.evaluation` 能力读取计分与报告；不读取原始模型密钥，也不改变实验。
 * 约束与禁忌：页面只读；创建实验与导出仍须经服务端角色与 scope 校验，不能由页面绕过。
 */
import { defineBrowserModuleDefinition } from "@ai-npc/client-sdk/define-browser-module";

export const evaluationPageModuleDefinition = defineBrowserModuleDefinition({
  id: "console.evaluation.standard",
  kind: "contributor",
  provides: "console.evaluation",
  requiresRemote: ["platform.evaluation"],
  contributions: [
    {
      extensionId: "console.evaluation.standard.page",
      slot: "console.page",
      order: 60,
      // 研究员与评估员都能读报告；写操作（创建实验）仍由服务端按角色裁决。
      allowedRoles: ["researcher", "evaluator"],
    },
  ],
  create: async (input) => {
    const { createEvaluationPageModule } = await import("./plugin");
    return createEvaluationPageModule(input);
  },
});
