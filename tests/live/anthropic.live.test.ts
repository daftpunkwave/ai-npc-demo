/**
 * 手动验证 Anthropic 实际模型的工具回放与 JSON schema 输出。
 * 只有进程提供 ANTHROPIC_API_KEY 时才完成真实传输。
 * 禁止读取或写入游戏存档、记录凭据或对请求做自动重试。
 */
import { it } from "vitest";
import { anthropicTransportDefinition } from "@ai-npc/mod-platform-model-transport-anthropic/definition";
import { modelConnection, transportPort } from "../support/model-transport";
import { verifyModelTransport } from "./model-smoke";

const key = process.env["ANTHROPIC_API_KEY"];

it.skipIf(!key)("Anthropic 模型完成工具往返与独立 JSON 调用", async () => {
  if (!key) throw new Error("请设置 ANTHROPIC_API_KEY");
  const port = await transportPort(anthropicTransportDefinition);
  await verifyModelTransport(port, key, modelConnection({ endpoint: null }), {
    externalModel: "claude-opus-5-5", parameters: { effort: "low", serverSideFallback: "off" },
  });
});
