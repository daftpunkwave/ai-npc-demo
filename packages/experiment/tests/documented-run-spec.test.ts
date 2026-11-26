/**
 * 验证配置文档里的 RunSpec 权威示例可以原样通过加载与交叉校验。
 * 依赖真实仓库配置与内容包；只读配置，不打开存储或启动模块。
 * 禁止放宽断言或改用与文档不同的字段值：本用例的用途就是锁住文档与实现的一致性。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContentPack, loadRoster, runSpecSchema, validateRunSpec } from "../src/index";
import { parseYamlText } from "../src/loading/yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loadContext = { configDir: resolve(repoRoot, "config"), env: process.env };
const content = loadContentPack(resolve(repoRoot, "content"), "earth-2964-v1");

/**
 * 与平台配置文档中 RunSpec 权威示例逐字段一致的规格。
 * 文档是使用者唯一可以照抄的权威样例，它一旦被预检拒绝就失去意义，
 * 因此这里把示例本身当成契约来验证，而不是另写一份「能通过」的近似值。
 */
const documentedRunSpec = `schemaVersion: 1
id: watergate-memory-ledger
experimentId: exp-memory-promise-v1
moduleAssemblyRef: local-slg-standard-v1
worldPackRef: earth-2964-v1
scenarioRef: watergate-v1
rosterRef: core-3
modelLayoutRef: shared-model-layout-v1
seed: run-seed-001
player:
  principalId: player-1
  factionId: human-neutral
mode: closed-loop
initialState:
  kind: cold-start
variant:
  id: structured-ledger
  profilePatchRefs: [memory-m1-structured-ledger]
  agentIds: null
script:
  scriptRef: s-promise
  branch: keep
clock:
  kind: controlled
budget:
  maxTokens: 2000000
  maxCost: null
failurePolicy: strict
`;

describe("配置文档的 RunSpec 权威示例", () => {
  it("原样通过 schema 与内容交叉校验", () => {
    const parsed = runSpecSchema.safeParse(parseYamlText(documentedRunSpec, "documented-run-spec"));
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(`文档示例未通过 schema：${JSON.stringify(parsed.error.issues)}`);
    }
    const roster = loadRoster(parsed.data.rosterRef, loadContext as never);
    expect(() => validateRunSpec(parsed.data, content, roster)).not.toThrow();
  });
});
