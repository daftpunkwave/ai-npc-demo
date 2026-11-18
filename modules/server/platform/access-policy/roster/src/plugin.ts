/**
 * 按角色名册裁决命令与控制台访问。
 * 依赖定义中的严格配置；无存储、无 I/O。
 * 禁止把页面自报角色当作授权来源。
 */
import type { ModuleCreateInput, ModuleInstance } from "@ai-npc/contracts";
import { createStatelessModule } from "@ai-npc/module-sdk";
import { accessPolicyConfigSchema, type AccessPolicyConfig } from "./definition";

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

/** 名册权限端口；规则在构造时冻结。 */
export class AccessPolicyPort {
  private readonly playerCommands: ReadonlySet<string>;
  private readonly consoleRoles: ReadonlySet<string>;

  constructor(config: AccessPolicyConfig) {
    this.playerCommands = new Set(config.playerCommands);
    this.consoleRoles = new Set(config.consoleRoles);
  }

  authorize(request: AccessRequest): AccessDecision {
    if (request.action === "console") {
      return this.consoleRoles.has(request.role)
        ? { allowed: true, reason: "allowed" }
        : { allowed: false, reason: "forbidden" };
    }
    if (request.role === "player") {
      return request.commandType !== undefined && this.playerCommands.has(request.commandType)
        ? { allowed: true, reason: "allowed" }
        : { allowed: false, reason: "forbidden" };
    }
    if (request.role === "operator") {
      return { allowed: true, reason: "allowed" };
    }
    return { allowed: false, reason: "unknown-role" };
  }
}

/** 按配置生成无状态权限名册。 */
export function createAccessPolicyModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const config = accessPolicyConfigSchema.parse(input.config);
  return createStatelessModule(input, new AccessPolicyPort(config));
}
