/**
 * 显式登记控制台首批页面模块定义，供浏览器握手与服务端目录共同校验。
 * 依赖模块纯定义入口；不加载 React 实现、模型 SDK 或服务端对象。
 * 禁止扫描目录或把顾问席页面写入玩家客户端。
 */
import { healthPageModuleDefinition } from "@ai-npc/mod-console-health-standard/definition";
import { moduleAdminPageModuleDefinition } from "@ai-npc/mod-console-module-admin-standard/definition";
import { observabilityPageModuleDefinition } from "@ai-npc/mod-console-observability-standard/definition";

export const consoleModuleDefinitions = [
  healthPageModuleDefinition,
  moduleAdminPageModuleDefinition,
  observabilityPageModuleDefinition,
] as const;
