/**
 * 维护每种命令允许的主体类型，并把真人席位代发折算为 Agent 权限。
 * 依赖公共契约的命令类型与主体类型；只做授权矩阵查询，不解析 payload。
 * 禁止在命令处理器内重复放宽发行者，也禁止让玩家会话取得控制台或 Agent 专属命令。
 */
import type { AuthContext, CommandType, PrincipalKind } from "@world-prism/contracts";
import { effectivePrincipalKind } from "./types";

/**
 * 命令发行者矩阵，按契约主体类型表达：player / agent / operator / researcher / system。
 * 领域模型命令目录中的席位（S）、运营（O）、宿主（H）与实验运行器（R）不逐字对应主体类型：
 * 席位命令由 operator 发行，宿主与实验运行器使用 system，真人席位代发按 agent 裁决。
 */
export const commandIssuerKinds = {
  "campaign.start": ["player", "system"],
  "dialogue.say": ["player"],
  "broadcast.say": ["player"],
  "speech.commit": ["agent", "system"],
  "seat.say": ["operator"],
  "information.share": ["player", "agent", "operator"],
  "agreement.propose": ["player", "agent", "operator"],
  "agreement.respond": ["player", "agent", "operator"],
  "task.dispatch": ["player", "agent", "operator"],
  "task.respond": ["agent"],
  "task.cancel": ["player", "agent", "operator"],
  "policy.set": ["player", "agent", "operator"],
  "scenario.draft": ["operator"],
  "scenario.publish": ["operator"],
  "scenario.withdraw": ["operator"],
  "scenario.compensate": ["operator"],
  "scenario.override": ["operator", "researcher"],
  "probe.ask": ["system"],
  "knowledge.seed": ["system"],
} as const satisfies Readonly<Record<CommandType, readonly PrincipalKind[]>>;

const issuerKindsByCommand = new Map<CommandType, readonly PrincipalKind[]>(
  Object.entries(commandIssuerKinds) as [CommandType, readonly PrincipalKind[]][],
);

/** 判断当前主体是否有资格发行该命令；真人席位代发按 Agent 权限裁决。 */
export function isCommandIssuerAllowed(type: CommandType, auth: AuthContext): boolean {
  const allowed = issuerKindsByCommand.get(type);
  if (allowed === undefined) {
    return false;
  }
  return allowed.includes(effectivePrincipalKind(auth));
}
