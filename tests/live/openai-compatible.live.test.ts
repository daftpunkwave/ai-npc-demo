/**
 * 手动验证部署选择的 OpenAI 兼容端点是否支持工具和 JSON 输出。
 * 只有进程提供 NPC_OPENAI_COMPAT_API_KEY 时才完成真实传输。
 * 禁止使用项目保存数据或向日志输出连接凭据。
 */
import { it } from "vitest";
import { openAICompatibleTransportDefinition } from "@world-prism/mod-platform-model-transport-openai-compatible/definition";
import { modelConnection, transportPort } from "../support/model-transport";
import { verifyModelTransport } from "./model-smoke";

const key = process.env["NPC_OPENAI_COMPAT_API_KEY"];

it.skipIf(!key)("OpenAI 兼容模型完成工具往返与独立 JSON 调用", async () => {
  const endpoint = process.env["NPC_OPENAI_COMPAT_BASE_URL"];
  const externalModel = process.env["NPC_OPENAI_COMPAT_MODEL"];
  if (!endpoint || !externalModel || !key) throw new Error("请设置兼容端点、模型名称与 API 密钥");
  const connection = modelConnection({ endpoint }, { assistantReplay: "verbatim" });
  await verifyModelTransport(await transportPort(openAICompatibleTransportDefinition), key, connection, { externalModel, parameters: {} });
});
