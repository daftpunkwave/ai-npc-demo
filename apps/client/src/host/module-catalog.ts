/**
 * 显式登记玩家客户端可装配的全部模块定义，供握手校验与浏览器运行时加载。
 * 依赖各客户端模块的纯定义入口；不加载 React 实现、PixiJS 或网络连接。
 * 禁止扫描目录、动态执行未知模块或把控制台页面加入玩家目录。
 */
import { cameraModuleDefinition } from "@world-prism/mod-client-camera-standard/definition";
import { charactersModuleDefinition } from "@world-prism/mod-client-characters-standard/definition";
import { dialogueModuleDefinition } from "@world-prism/mod-client-dialogue-standard/definition";
import { factionStartModuleDefinition } from "@world-prism/mod-client-faction-start-standard/definition";
import { hudModuleDefinition } from "@world-prism/mod-client-hud-standard/definition";
import { inputModuleDefinition } from "@world-prism/mod-client-input-standard/definition";
import { notificationsModuleDefinition } from "@world-prism/mod-client-notifications-standard/definition";
import { nullSceneModuleDefinition } from "@world-prism/mod-client-scene-renderer-null/definition";
import { pixiSceneModuleDefinition } from "@world-prism/mod-client-scene-renderer-pixi/definition";
import { projectionModuleDefinition } from "@world-prism/mod-client-screen-projection-isometric/definition";
import { settingsModuleDefinition } from "@world-prism/mod-client-settings-standard/definition";
import { worldViewModuleDefinition } from "@world-prism/mod-client-world-view-standard/definition";

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
