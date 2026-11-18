/**
 * 按角色名册裁决命令与控制台访问。
 * 依赖定义中的严格配置；无存储、无 I/O。
 * 禁止把页面自报角色当作授权来源。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { accessPolicyConfigSchema } from "./definition";

export interface AccessRequest {
  readonly principalId: string;
  readonly role: string;
  readonly action: "command" | "console";
  readonly commandType?: string;
}

export interface AccessDecision {
  readonly allowed: boolean;
  readonly reason: "allowed" | "forbidden" | "unknown-role";
}

function authorizeHook(request: AccessRequest): AccessDecision {
  return { allowed: request.role.length > 0, reason: "allowed" };
}

export interface AccessPolicyPort {
  authorize: typeof authorizeHook;
}

/** 按配置生成无状态权限名册。 */
export function createAccessPolicyModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = accessPolicyConfigSchema.parse(input.config);
  const playerCommands = new Set(config.playerCommands);
  const consoleRoles = new Set<string>(config.consoleRoles);
  const port: AccessPolicyPort = {
    authorize: (request) => {
      if (request.action === "console") {
        return consoleRoles.has(request.role)
          ? { allowed: true, reason: "allowed" }
          : { allowed: false, reason: "forbidden" };
      }
      if (request.role === "player") {
        if (request.commandType === undefined || !playerCommands.has(request.commandType)) {
          return { allowed: false, reason: "forbidden" };
        }
        return { allowed: true, reason: "allowed" };
      }
      if (request.role === "operator") {
        return { allowed: true, reason: "allowed" };
      }
      return { allowed: false, reason: "unknown-role" };
    },
  };
  return createStatelessModule(input, port);
}
