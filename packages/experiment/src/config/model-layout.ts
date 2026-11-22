/**
 * 加载集中模型布局、测试夹具和计费价目。
 * 模型名与端点可引用部署环境，密钥引用始终保留为引用。
 * 禁止读取夹具目录以外的正文、插入凭据或接受未校验的传输参数。
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { jsonValueSchema, modelCapabilitiesSchema, modelFixtureSchema, modelPurposeSchema, moduleIdSchema, principalIdSchema } from "@ai-npc/contracts";
import { LoadingError, schemaLoadingError } from "../loading/errors";
import { parseYamlText } from "../loading/yaml";
import { envReferenceName, loadConfigDocument, resolveConfigReference, type ConfigLoadContext } from "./load-config";
import { configRefSchema } from "./schema";

const positive = z.number().int().positive();
const name = z.string().min(1);
const credentialRef = z.string().regex(/^(?:env:)?[A-Za-z_][A-Za-z0-9_]*$/u);
const fixturePath = z.string().regex(/^tests\/fixtures\/model\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.jsonl$/u);
const gameplayPurpose = modelPurposeSchema.exclude(["evaluation"]);
const connectionSchema = z.object({
  adapterId: moduleIdSchema,
  endpoint: name.optional(),
  credentialRef: credentialRef.nullable().default(null),
  rateLimitKey: configRefSchema.optional(),
  fixtureFiles: z.array(fixturePath).max(32).default([]),
}).strict();

const modelSchema = z.object({
  connectionId: configRefSchema,
  externalModel: name,
  parameters: jsonValueSchema.default({}),
  capabilities: modelCapabilitiesSchema,
  limits: z.object({
    maxConcurrent: positive, requestsPerMinute: positive, tokensPerMinute: positive, requestTimeoutMs: positive,
  }).strict(),
  maxOutputTokensByPurpose: z.partialRecord(modelPurposeSchema, positive).default({}),
}).strict();

const modelLayoutSchema = z.object({
  schemaVersion: z.literal(1),
  layoutId: configRefSchema,
  pricingRef: configRefSchema.optional(),
  connections: z.record(configRefSchema, connectionSchema),
  models: z.record(configRefSchema, modelSchema),
  mounts: z.array(z.object({
    modelId: configRefSchema,
    agentIds: z.array(principalIdSchema).min(1),
    purposes: z.array(gameplayPurpose).min(1),
  }).strict()),
  evaluator: z.object({
    enabled: z.boolean(),
    principalId: principalIdSchema,
    modelId: configRefSchema,
  }).strict().optional(),
}).strict();

const pricingSchema = z.object({
  schemaVersion: z.literal(1),
  pricingVersion: name,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  models: z.record(configRefSchema, z.object({
    inputPerMTok: z.number().nonnegative(), outputPerMTok: z.number().nonnegative(),
  }).strict()),
}).strict();

export type ModelLayout = z.infer<typeof modelLayoutSchema>;

export function loadModelLayout(modelLayoutRef: string, context: ConfigLoadContext): ModelLayout {
  const ref = resolveConfigReference(modelLayoutRef, context, "model-layout");
  const source = ref.kind === "file" ? ref.path : ref.configRef;
  const data = ref.kind === "file" ? parseYamlText(ref.text, source) : ref.value;
  const parsed = modelLayoutSchema.safeParse(data);
  if (!parsed.success) throw schemaLoadingError(source, parsed.error);
  if (parsed.data.layoutId !== modelLayoutRef) {
    throw new LoadingError({ code: "reference", source, message: "模型布局 ID 与文件引用不一致" });
  }
  return parsed.data;
}

export function loadModelPricing(context: ConfigLoadContext, ref = "pricing") {
  return loadConfigDocument(ref, pricingSchema, context).value;
}

const publicModelEnv = ["NPC_OPENAI_COMPAT_BASE_URL", "NPC_OPENAI_COMPAT_MODEL"] as const;

export function resolveModelEnv(value: string, context: ConfigLoadContext, allowed?: typeof publicModelEnv[number]): string {
  if (!value.startsWith("env:")) return value;
  const key = envReferenceName(value);
  const permitted = allowed === undefined ? publicModelEnv : [allowed];
  if (key === null || !permitted.some((name) => name === key)) {
    throw new LoadingError({ code: "env", source: "model-layout", message: `模型参数只允许引用 ${permitted.join(" 或 ")}` });
  }
  const env = context.env ?? {};
  const resolved = Object.hasOwn(env, key) ? env[key]?.trim() : undefined;
  if (!resolved?.trim()) {
    throw new LoadingError({ code: "env", source: "model-layout", message: `模型布局需要设置 ${key}` });
  }
  return resolved;
}

export function loadModelFixtures(paths: readonly string[], context: ConfigLoadContext) {
  const repo = realpathSync(resolve(context.configDir, ".."));
  const fixtureRoot = realpathSync(resolve(repo, "tests/fixtures/model"));
  const fixtureLocation = relative(repo, fixtureRoot);
  if (isAbsolute(fixtureLocation) || fixtureLocation.startsWith("..")) {
    throw new LoadingError({ code: "reference", source: "tests/fixtures/model", message: "夹具目录越出项目目录" });
  }
  const ids = new Set<string>();
  return paths.flatMap((ref) => {
    const file = realpathSync(resolve(repo, fixturePath.parse(ref)));
    const local = relative(fixtureRoot, file);
    if (isAbsolute(local) || local.startsWith("..")) {
      throw new LoadingError({ code: "reference", source: ref, message: "夹具路径越出夹具目录" });
    }
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size > 1_048_576) {
      throw new LoadingError({ code: "reference", source: ref, message: "夹具必须是目录内不超过 1 MiB 的普通文件" });
    }
    return readFileSync(file, "utf8").split(/\r?\n/u).flatMap((line, index) => {
      if (!line.trim()) return [];
      const source = `${ref}:${index + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new LoadingError({ code: "reference", source, message: "夹具行不是合法 JSON" });
      }
      const fixture = modelFixtureSchema.safeParse(value);
      if (!fixture.success) throw schemaLoadingError(source, fixture.error);
      if (ids.has(fixture.data.id)) {
        throw new LoadingError({ code: "reference", source, message: "连接内的夹具 ID 重复" });
      }
      ids.add(fixture.data.id);
      return [fixture.data];
    });
  });
}
