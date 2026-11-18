/**
 * 校验实验脚本步骤、探针与分支引用的主体和内容对象。
 * 依赖公共契约的命令类型、内容索引与内容 schema 类型；只读取已解析数据。
 * 禁止在此执行命令、改写脚本或跳过引用检查。
 */
import type { CommandRequest } from "@ai-npc/contracts";
import type { ContentIndex } from "../content-index";
import type { ContentScript, ContentScriptStep } from "../schema/index";
import { fail } from "./common";

/** 从外部脚本命令中取出内容 ID 引用，供跨文件校验使用。 */
function checkCommandReferences(
  command: CommandRequest,
  path: string,
  index: ContentIndex,
  source: string,
): void {
  const requirePrincipal = (id: string, field: string): void => {
    if (!index.principalIds.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `主体「${id}」不存在`);
    }
  };
  const requireNode = (id: string, field: string): void => {
    if (!index.nodes.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `节点「${id}」不存在`);
    }
  };
  const requireStockpile = (id: string, field: string): void => {
    if (!index.stockpiles.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `库存点「${id}」不存在`);
    }
  };
  const requireTeam = (id: string, field: string): void => {
    if (!index.teams.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `队伍「${id}」不存在`);
    }
  };
  const requireRoad = (id: string, field: string): void => {
    if (!index.roads.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `道路「${id}」不存在`);
    }
  };
  const requireGroup = (id: string, field: string): void => {
    if (!index.groups.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `群体「${id}」不存在`);
    }
  };
  const requireEvidence = (id: string, field: string): void => {
    if (!index.evidence.has(id)) {
      fail(source, `${path}.command.payload.${field}`, `证据「${id}」不存在`);
    }
  };
  const checkTerm = (
    term: Extract<CommandRequest, { type: "agreement.propose" }>["payload"]["terms"][number],
    field: string,
  ): void => {
    requirePrincipal(term.obligorId, `${field}.obligorId`);
    if (term.kind === "deliver") {
      requireStockpile(term.fromStockpileId, `${field}.fromStockpileId`);
      requireStockpile(term.toStockpileId, `${field}.toStockpileId`);
    }
    if (term.kind === "escort") requireRoad(term.roadId, `${field}.roadId`);
    if (term.kind === "rescue") requireGroup(term.groupId, `${field}.groupId`);
    if (term.kind === "share-evidence") {
      requireEvidence(term.evidenceId, `${field}.evidenceId`);
      requirePrincipal(term.toPrincipalId, `${field}.toPrincipalId`);
    }
    if (term.kind === "grant-passage") requireRoad(term.roadId, `${field}.roadId`);
    if (term.kind === "delegate") {
      term.teamIds.forEach((teamId, teamIndex) => requireTeam(teamId, `${field}.teamIds.${teamIndex}`));
      if (term.stockpileId !== null) requireStockpile(term.stockpileId, `${field}.stockpileId`);
      requirePrincipal(term.granteeId, `${field}.granteeId`);
    }
  };

  switch (command.type) {
    case "campaign.start":
      if (!index.factions.has(command.payload.factionId)) {
        fail(source, `${path}.command.payload.factionId`, `派系「${command.payload.factionId}」不存在`);
      }
      break;
    case "dialogue.say":
      requirePrincipal(command.payload.targetAgentId, "targetAgentId");
      break;
    case "seat.say":
      command.payload.to.forEach((id, toIndex) => requirePrincipal(id, `to.${toIndex}`));
      break;
    case "information.share":
      requireEvidence(command.payload.evidenceId, "evidenceId");
      command.payload.audience.forEach((id, audienceIndex) => requirePrincipal(id, `audience.${audienceIndex}`));
      break;
    case "agreement.propose":
      command.payload.parties.forEach((id, partyIndex) => requirePrincipal(id, `parties.${partyIndex}`));
      command.payload.terms.forEach((term, termIndex) => checkTerm(term, `terms.${termIndex}`));
      break;
    case "agreement.respond":
      command.payload.counterTerms?.forEach((term, termIndex) => checkTerm(term, `counterTerms.${termIndex}`));
      break;
    case "task.dispatch":
      requireTeam(command.payload.teamId, "teamId");
      command.payload.invitees?.forEach((id, inviteeIndex) => requirePrincipal(id, `invitees.${inviteeIndex}`));
      if (command.payload.taskType === "transport") {
        requireStockpile(command.payload.params.fromStockpileId, "params.fromStockpileId");
        requireStockpile(command.payload.params.toStockpileId, "params.toStockpileId");
      }
      if (command.payload.taskType === "escort") requireRoad(command.payload.params.roadId, "params.roadId");
      if (command.payload.taskType === "rescue") {
        requireGroup(command.payload.params.groupId, "params.groupId");
        requireNode(command.payload.params.toNodeId, "params.toNodeId");
        requireStockpile(command.payload.params.medicalStockpileId, "params.medicalStockpileId");
      }
      if (command.payload.taskType === "repair") {
        requireStockpile(command.payload.params.energyStockpileId, "params.energyStockpileId");
        if (command.payload.params.supplyStockpileId !== null) {
          requireStockpile(command.payload.params.supplyStockpileId, "params.supplyStockpileId");
        }
      }
      if (command.payload.taskType === "scout") requireNode(command.payload.params.nodeId, "params.nodeId");
      break;
    case "policy.set":
      if (command.payload.key.startsWith("road.status:")) {
        requireRoad(command.payload.key.slice("road.status:".length), "key");
      }
      break;
    case "scenario.compensate":
      command.payload.effects.forEach((effect, effectIndex) => {
        if (effect.kind === "broadcast" && !index.principalIds.has(effect.speakerId)) {
          fail(source, `${path}.command.payload.effects.${effectIndex}.speakerId`, `广播署名「${effect.speakerId}」不存在`);
        }
        if (effect.kind === "message") {
          effect.to.forEach((id, toIndex) => requirePrincipal(id, `effects.${effectIndex}.to.${toIndex}`));
        }
        if (effect.kind === "wake-agents") {
          effect.agentIds.forEach((id, agentIndex) => {
            if (!index.agentIds.has(id)) {
              fail(source, `${path}.command.payload.effects.${effectIndex}.agentIds.${agentIndex}`, `召集对象「${id}」不存在`);
            }
          });
        }
      });
      break;
    default:
      break;
  }
}

/** 校验脚本步骤、探针、预置知识与分支引用的主体与内容对象。 */
export function checkScripts(
  scripts: ReadonlyMap<string, ContentScript>,
  index: ContentIndex,
): void {
  const checkStep = (step: ContentScriptStep, path: string, source: string): void => {
    if (!index.principalIds.has(step.as)) {
      fail(source, `${path}.as`, `脚本执行主体「${step.as}」不存在`);
    }
    checkCommandReferences(step.command, path, index, source);
  };
  for (const [file, script] of scripts) {
    if (!index.factions.has(script.start.factionId)) {
      fail(file, "start.factionId", `脚本开局的派系「${script.start.factionId}」不存在`);
    }
    script.steps.forEach((step, stepIndex) => checkStep(step, `steps.${stepIndex}`, file));
    script.branches?.forEach((branch, branchIndex) => {
      branch.addSteps.forEach((step, stepIndex) =>
        checkStep(step, `branches.${branchIndex}.addSteps.${stepIndex}`, file),
      );
    });
    script.setup?.forEach((setup, setupIndex) => {
      if (!index.evidence.has(setup.grantEvidence)) {
        fail(file, `setup.${setupIndex}.grantEvidence`, `预置知识「${setup.grantEvidence}」不存在`);
      }
      if (!index.principalIds.has(setup.to)) {
        fail(file, `setup.${setupIndex}.to`, `预置知识接收方「${setup.to}」不存在`);
      }
    });
    script.checkpoints.forEach((checkpoint, checkpointIndex) => {
      checkpoint.probes.forEach((probe, probeIndex) => {
        const path = `checkpoints.${checkpointIndex}.probes.${probeIndex}`;
        if (!index.agentIds.has(probe.agentId)) {
          fail(file, `${path}.agentId`, `探针对象「${probe.agentId}」不是内容身份`);
        }
        if (!index.principalIds.has(probe.askedBy)) {
          fail(file, `${path}.askedBy`, `提问者「${probe.askedBy}」不存在`);
        }
      });
    });
  }
}
