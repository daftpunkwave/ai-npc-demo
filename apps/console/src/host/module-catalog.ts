/**
 * 显式登记控制台页面模块定义，供浏览器握手与服务端目录共同校验。
 * 依赖模块纯定义入口；不加载 React 实现、模型 SDK 或服务端对象。
 * 禁止扫描目录或把顾问席页面写入玩家客户端。
 */
import { healthPageModuleDefinition } from "@world-prism/mod-console-health-standard/definition";
import { moduleAdminPageModuleDefinition } from "@world-prism/mod-console-module-admin-standard/definition";
import { modelMountsPageModuleDefinition } from "@world-prism/mod-console-model-mounts-standard/definition";
import { factionOpsPageModuleDefinition } from "@world-prism/mod-console-faction-ops-standard/definition";
import { debugPageModuleDefinition } from "@world-prism/mod-console-debug-standard/definition";
import { observabilityPageModuleDefinition } from "@world-prism/mod-console-observability-standard/definition";
import { evaluationPageModuleDefinition } from "@world-prism/mod-console-evaluation-standard/definition";

export const consoleModuleDefinitions = [
  healthPageModuleDefinition,
  moduleAdminPageModuleDefinition,
  modelMountsPageModuleDefinition,
  factionOpsPageModuleDefinition,
  observabilityPageModuleDefinition,
  evaluationPageModuleDefinition,
  debugPageModuleDefinition,
] as const;
