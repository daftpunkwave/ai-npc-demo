/**
 * 核心职责：为一个 run 组装命令网关与规则机制：注册装配内全部游戏模块贡献，并把名册激活挂到 `campaign.start` 之后。
 * 交互契约：依赖宿主启动聚合中的存储、宿主服务、内容视图、端口绑定器与规则贡献；随机种子与对白批准索引由 run 提供。
 * 约束与禁忌：每个 run 一份实例：随机种子决定任务风险等规则抽样，名册决定开局激活的身份，二者都不能借用其他 run 的；
 * 不启动后台循环、不写世界状态。
 */
import { Authority } from "@world-prism/authority";
import { createCampaignStartActivationHook, type SpeechApprovalIndex } from "@world-prism/agent-runtime";
import type { HostStartup } from "./startup-types";

/** 构造一个 run 的命令网关；名册为空（装配不含 Agent 运行时）时不挂激活钩子。 */
export function createWorldAuthority(input: {
  readonly core: HostStartup;
  readonly runSeed: string;
  readonly approvals: SpeechApprovalIndex;
  readonly rosterAgentIds: readonly string[] | undefined;
}): Authority {
  const { core } = input;
  const authority = new Authority({
    storage: core.storage,
    host: core.host,
    content: core.gameContent,
    moduleBinder: core.runtime.binder,
    runSeed: input.runSeed,
    approvedSpeech: input.approvals,
  });
  for (const contributor of core.runtime.contributors) {
    authority.registerModule(contributor);
  }
  if (input.rosterAgentIds !== undefined) {
    authority.hostAfterCommand(
      "agent-runtime",
      "campaign.start",
      createCampaignStartActivationHook({ agentIds: input.rosterAgentIds, nowIso: () => core.host.nowIso() }),
    );
  }
  return authority;
}
