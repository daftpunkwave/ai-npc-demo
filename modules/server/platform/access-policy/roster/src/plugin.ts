/**
 * 按角色名册裁决玩家入口、命令、控制台接口、控制台会话与 WS 频道。
 * 依赖定义中的严格配置与 API 第 4 节声明的频道角色；无存储、无 I/O。
 * 禁止把页面自报角色当作授权来源，也禁止让传输层自行维护角色白名单。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { accessPolicyConfigSchema, type AccessPolicyConfig } from "./definition";

/** 需要裁决的动作：玩家入口、命令、控制台接口、控制台会话握手与 WS 频道。 */
export type AccessAction = "player" | "command" | "console" | "console-session" | "channel";

export interface AccessRequest {
  readonly principalId: string;
  readonly role: string;
  readonly action: AccessAction;
  readonly commandType?: string;
  readonly channel?: string;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: "allowed" | "forbidden" | "unknown-role";
}

const allow = (): AccessDecision => ({ allowed: true, reason: "allowed" });

const deny = (reason: "forbidden" | "unknown-role" = "forbidden"): AccessDecision => ({
  allowed: false,
  reason,
});

/**
 * 频道与可订阅角色的对应关系固定取自 API 第 4 节。
 * 频道集合不进入部署配置，避免把玩家频道或研究频道放宽给其他角色。
 */
const channelRoles: Readonly<Record<string, readonly string[]>> = {
  player: ["player"],
  "console.health": ["operator", "researcher"],
  "console.timeline": ["researcher"],
  "console.turns": ["researcher"],
};

/** 可持有控制台会话的角色；控制台装配握手对所有控制台角色开放。 */
const consoleSessionRoles: ReadonlySet<string> = new Set(["operator", "researcher", "evaluator"]);

/** 名册权限端口；规则在构造时冻结。 */
export class AccessPolicyPort {
  private readonly playerCommands: ReadonlySet<string>;
  private readonly consoleRoles: ReadonlySet<string>;

  constructor(config: AccessPolicyConfig) {
    this.playerCommands = new Set(config.playerCommands);
    this.consoleRoles = new Set(config.consoleRoles);
  }

  authorize(request: AccessRequest): AccessDecision {
    switch (request.action) {
      case "player":
        return request.role === "player" ? allow() : deny();
      case "command": {
        if (request.role === "player") {
          return request.commandType !== undefined && this.playerCommands.has(request.commandType)
            ? allow()
            : deny();
        }
        // 与既有名册一致：operator 可发行控制台运营命令；其他角色不在此入口放行。
        if (request.role === "operator") {
          return allow();
        }
        return deny("unknown-role");
      }
      case "console":
        return this.consoleRoles.has(request.role) ? allow() : deny();
      case "console-session":
        return consoleSessionRoles.has(request.role) ? allow() : deny();
      case "channel": {
        const roles = channelRoles[request.channel ?? ""];
        return roles?.includes(request.role) === true ? allow() : deny();
      }
      default:
        return deny("unknown-role");
    }
  }
}

/** 按配置生成无状态权限名册。 */
export function createAccessPolicyModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = accessPolicyConfigSchema.parse(input.config);
  return createStatelessModule(input, new AccessPolicyPort(config));
}
