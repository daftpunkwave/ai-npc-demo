/**
 * 显式登记玩家客户端可装配的全部模块定义，供握手校验与浏览器运行时加载。
 * 依赖各客户端模块的纯定义入口；不加载 React 实现、PixiJS 或网络连接。
 * 禁止扫描目录、动态执行未知模块或把控制台页面加入玩家目录。
 */
import { cameraModuleDefinition } from "@ai-npc/mod-client-camera-standard/definition";
import { charactersModuleDefinition } from "@ai-npc/mod-client-characters-standard/definition";
import { dialogueModuleDefinition } from "@ai-npc/mod-client-dialogue-standard/definition";
import { factionStartModuleDefinition } from "@ai-npc/mod-client-faction-start-standard/definition";
import { hudModuleDefinition } from "@ai-npc/mod-client-hud-standard/definition";
import { inputModuleDefinition } from "@ai-npc/mod-client-input-standard/definition";
import { notificationsModuleDefinition } from "@ai-npc/mod-client-notifications-standard/definition";
import { nullSceneModuleDefinition } from "@ai-npc/mod-client-scene-renderer-null/definition";
import { pixiSceneModuleDefinition } from "@ai-npc/mod-client-scene-renderer-pixi/definition";
import { projectionModuleDefinition } from "@ai-npc/mod-client-screen-projection-isometric/definition";
import { settingsModuleDefinition } from "@ai-npc/mod-client-settings-standard/definition";
import { worldViewModuleDefinition } from "@ai-npc/mod-client-world-view-standard/definition";

export const clientModuleDefinitions = [
  worldViewModuleDefinition,
  pixiSceneModuleDefinition,
  nullSceneModuleDefinition,
  cameraModuleDefinition,
  projectionModuleDefinition,
  inputModuleDefinition,
  hudModuleDefinition,
  dialogueModuleDefinition,
  factionStartModuleDefinition,
  charactersModuleDefinition,
  settingsModuleDefinition,
  notificationsModuleDefinition,
] as const;
