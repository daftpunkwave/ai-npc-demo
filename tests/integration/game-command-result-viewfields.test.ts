/**
 * 核心职责：验证成功命令回执的 result 携带共享工具目录声明 viewFields 的全部字段。
 * 交互契约：使用真实游戏 harness 经命令网关执行命令，并从内容包描述构造游戏工具目录。
 * 约束与禁忌：不得在测试里手写 viewFields 期望值，也不得绕过命令网关构造回执。
 */
import { describe, expect, it } from "vitest";
import type { Term } from "@ai-npc/contracts";
import { loadContentPack } from "@ai-npc/experiment";
import { gameToolsModuleDefinition, type GameToolsCatalogPort } from "@ai-npc/mod-agent-tools-game-tools";
import {
  executeCommand,
  playerAuth,
  proposeAgreement,
  respondAgreement,
  strategicAuth,
  useStartedGameHarnesses,
  type GameHarness,
  type Receipt,
} from "./game-agreement-support";
import { createFakeHost } from "./authority-support";

const harness = useStartedGameHarnesses();

/** 玩家向人类中立交付 10 点供给的条款；与协议测试的默认交付条款一致。 */
const deliveryTerm: Term = {
  kind: "deliver",
  obligorId: "player-1",
  resource: "supply",
  amount: 10,
  fromStockpileId: "sp-commons",
  toStockpileId: "sp-earth",
  byTick: 30,
};

/** 以内容包工具描述构造共享游戏工具目录；viewFields 声明与命令实现同源。 */
async function gameToolsCatalog(): Promise<GameToolsCatalogPort> {
  const content = loadContentPack("content", "earth-2964-v1");
  const instance = await gameToolsModuleDefinition.create({
    moduleId: gameToolsModuleDefinition.id,
    realm: "server",
    config: { toolDescriptions: content.prompts.toolDescriptions },
    scope: {},
    ports: {},
    host: createFakeHost(),
    signal: new AbortController().signal,
  });
  return instance.port as GameToolsCatalogPort;
}

/** 断言回执成功且 result 包含工具声明 viewFields 的全部字段；缺字段时工具视图会渲染空数据。 */
function expectCarriesViewFields(tools: GameToolsCatalogPort, toolId: string, receipt: Receipt): void {
  const definition = tools.definition(toolId, "1");
  if (definition === null) {
    throw new Error(`工具定义缺失：${toolId}`);
  }
  expect(definition.commandType).not.toBeNull();
  expect(receipt.commandStatus).toBe("accepted");
  expect(receipt.result).not.toBeNull();
  const keys = Object.keys(receipt.result as Record<string, unknown>);
  for (const field of definition.viewFields) {
    expect(keys).toContain(field);
  }
}

describe("命令回执 result 与工具 viewFields 兼容", () => {
  it("协议、分享与政策命令的成功回执携带声明 viewFields 的全部字段", async () => {
    const tools = await gameToolsCatalog();
    const value: GameHarness = await harness();

    const proposed = executeCommand(value, playerAuth(value), "agreement.propose", {
      parties: ["player-1", "human-neutral"],
      terms: [deliveryTerm],
    });
    expectCarriesViewFields(tools, "agreement.propose", proposed);
    const agreementId = (proposed.result as { readonly agreementId: string }).agreementId;

    expectCarriesViewFields(
      tools,
      "agreement.respond",
      respondAgreement(value, strategicAuth(value, "human-neutral"), agreementId, "accept"),
    );

    expectCarriesViewFields(
      tools,
      "information.share",
      executeCommand(value, playerAuth(value), "information.share", {
        evidenceId: "ev-water-ledger",
        audience: ["species-fauna"],
      }),
    );

    expectCarriesViewFields(
      tools,
      "policy.set",
      executeCommand(value, strategicAuth(value, "human-independent"), "policy.set", {
        key: "road.status:r-gh-ps",
        value: "closed",
      }),
    );
  });
});
