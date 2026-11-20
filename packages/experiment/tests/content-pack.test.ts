/**
 * 内容包加载与交叉检查测试：完整加载、单点篡改与名册配额。
 * 依赖 experiment 包的公开加载入口与真实内容包；断言失败信息能定位到文件与字段路径。
 * 禁止在此修改仓库内容文件；所有篡改只作用于内存中的文件映射。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LoadingError,
  loadContentPack,
  loadRoster,
  parseContentPack,
  readContentPackSources,
  rosterSchema,
  type ContentPackSources,
  type Roster,
  validateRoster,
} from "../src/index";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contentRoot = resolve(repoRoot, "content");
const fixturesConfigDir = resolve(repoRoot, "tests/fixtures/config");
const packId = "earth-2964-v1";

/** 读取真实内容包并在内存中替换一处文本，返回可重新解析的源映射。 */
function mutatedSources(file: string, search: string, replacement: string): ContentPackSources {
  const sources = readContentPackSources(contentRoot, packId);
  const text = sources.files.get(file);
  if (text === undefined) {
    throw new Error(`测试夹具缺少文件 ${file}`);
  }
  const mutated = text.replace(search, replacement);
  if (mutated === text) {
    throw new Error(`测试夹具未找到要替换的文本：${search}`);
  }
  const files = new Map(sources.files);
  files.set(file, mutated);
  return { packId: sources.packId, files };
}

/** 断言加载失败并返回可检查来源、路径与消息的错误。 */
function captureLoadingError(load: () => unknown): LoadingError {
  try {
    load();
  } catch (error) {
    if (error instanceof LoadingError) {
      return error;
    }
    throw error;
  }
  throw new Error("预期加载失败，但实际成功");
}

describe("内容包加载", () => {
  it("完整内容包通过 schema 与交叉检查", () => {
    const pack = loadContentPack(contentRoot, packId);
    expect(pack.pack.contentVersion).toBe("0.2.0");
    expect(pack.pack.defaultScenario).toBe("watergate-v1");
    expect(pack.index.nodes.size).toBe(6);
    expect(pack.index.roads.size).toBe(9);
    expect(pack.index.factions.size).toBe(8);
    expect(pack.index.characters.size).toBe(11);
    expect(pack.index.stockpiles.size).toBe(8);
    expect(pack.index.teams.size).toBe(8);
    expect(pack.index.groups.size).toBe(1);
    expect(pack.index.evidence.size).toBe(5);
    expect(pack.index.secrets.size).toBe(4);
    expect(pack.index.starts.size).toBe(5);
    expect([...pack.index.starts.values()].filter((start) => start.enabled).map((start) => start.factionId)).toEqual([
      "human-neutral",
    ]);
    expect(pack.index.cards.size).toBe(9);
    expect(pack.index.scenarios.size).toBe(1);
    expect(pack.index.scripts.size).toBe(3);
    expect(pack.index.playerPrincipalId).toBe("player-1");
    expect(pack.prompts.observationTemplates.CampaignStarted).toBe("战役已开始。");
    expect(pack.prompts.termTemplates.deliver).toContain("{obligorName}");
    expect(pack.locale.reasonCodes["past-breach"]).toBe("对方上次没有兑现。");
    expect(pack.index.scripts.get("s-promise")?.checkpoints[0]?.probes[0]?.probeId).toBe(
      "p-recall-promise",
    );
  });

  it("道路引用不存在的节点时错误定位到 map.yaml 的字段", () => {
    const sources = mutatedSources(
      "map.yaml",
      "{ roadId: r-gh-wg, a: grayharbor",
      "{ roadId: r-gh-wg, a: nowhere",
    );
    const error = captureLoadingError(() => parseContentPack(sources));
    expect(error.code).toBe("cross-check");
    expect(error.source).toBe("map.yaml");
    expect(error.path).toBe("roads.0.a");
    expect(error.message).toContain("nowhere");
  });

  it("重复的角色 ID 时错误定位到 characters.yaml", () => {
    const sources = mutatedSources("characters.yaml", "agentId: npc-yinuo", "agentId: npc-wenzhao");
    const error = captureLoadingError(() => parseContentPack(sources));
    expect(error.code).toBe("cross-check");
    expect(error.source).toBe("characters.yaml");
    expect(error.path).toBe("characters.1.agentId");
    expect(error.message).toContain("npc-wenzhao");
  });

  it("缺少观察模板时错误定位到 prompts/zh-CN.yaml", () => {
    const sources = mutatedSources("prompts/zh-CN.yaml", "  CampaignStarted: 战役已开始。\n", "");
    const error = captureLoadingError(() => parseContentPack(sources));
    expect(error.code).toBe("schema");
    expect(error.source).toBe("prompts/zh-CN.yaml");
    expect(error.path).toBe("observationTemplates.CampaignStarted");
  });

  it("缺少词表键时错误定位到 locale/zh-CN.yaml", () => {
    const sources = mutatedSources(
      "locale/zh-CN.yaml",
      '  forgetMarkers: ["不记得", "忘了"]\n',
      "",
    );
    const error = captureLoadingError(() => parseContentPack(sources));
    expect(error.code).toBe("schema");
    expect(error.source).toBe("locale/zh-CN.yaml");
    expect(error.path).toBe("lexicons.forgetMarkers");
  });

  it("拒绝含路径分隔符的内容包 ID", () => {
    const error = captureLoadingError(() => readContentPackSources(contentRoot, "../earth-2964-v1"));
    expect(error.code).toBe("reference");
    expect(error.source).toBe("../earth-2964-v1");
  });

  it("声明文件缺失、重复或未登记时拒绝加载", () => {
    const missingSources = readContentPackSources(contentRoot, packId);
    const missingFiles = new Map(missingSources.files);
    missingFiles.delete("map.yaml");
    const missing = captureLoadingError(() =>
      parseContentPack({ packId: missingSources.packId, files: missingFiles }),
    );
    expect(missing.code).toBe("missing-file");
    expect(missing.source).toBe("map.yaml");

    const duplicate = captureLoadingError(() =>
      parseContentPack(mutatedSources("pack.yaml", "files: [lore.yaml,", "files: [lore.yaml, lore.yaml,")),
    );
    expect(duplicate.code).toBe("cross-check");
    expect(duplicate.path).toBe("files.1");

    const extra = captureLoadingError(() =>
      parseContentPack(
        mutatedSources("pack.yaml", "locale/zh-CN.yaml]", "locale/zh-CN.yaml, extra.yaml]"),
      ),
    );
    expect(extra.code).toBe("unexpected-file");
    expect(extra.path).toBe("files.9");
  });

  it("全局 ID 冲突与不可达证据被拒绝", () => {
    const conflict = captureLoadingError(() =>
      parseContentPack(mutatedSources("characters.yaml", "agentId: npc-wenzhao", "agentId: human-neutral")),
    );
    expect(conflict.code).toBe("cross-check");
    expect(conflict.source).toBe("characters.yaml");
    expect(conflict.path).toBe("characters.0");
    expect(conflict.message).toContain("human-neutral");

    const unreachable = captureLoadingError(() =>
      parseContentPack(mutatedSources("evidence.yaml", "discoverable: true", "discoverable: false")),
    );
    expect(unreachable.code).toBe("cross-check");
    expect(unreachable.source).toBe("evidence.yaml");
    expect(unreachable.path).toBe("evidence.0");
  });

  it("脚本命令引用错误定位到具体脚本文件", () => {
    const sources = mutatedSources(
      "scripts/s-promise.yaml",
      "targetAgentId: human-independent",
      "targetAgentId: npc-nobody",
    );
    const error = captureLoadingError(() => parseContentPack(sources));
    expect(error.code).toBe("cross-check");
    expect(error.source).toBe("scripts/s-promise.yaml");
    expect(error.path).toBe("steps.0.command.payload.targetAgentId");
  });

  it("理由模板只允许 none 为空", () => {
    const error = captureLoadingError(() =>
      parseContentPack(mutatedSources("prompts/zh-CN.yaml", "danger: 太危险了。", 'danger: ""')),
    );
    expect(error.code).toBe("schema");
    expect(error.source).toBe("prompts/zh-CN.yaml");
    expect(error.path).toBe("speechReasons.danger");
  });
});

describe("名册校验", () => {
  const content = loadContentPack(contentRoot, packId);

  it("standard-15 与 core-3 都通过身份存在性检查", () => {
    const standard = loadRoster("standard-15", { configDir: resolve(repoRoot, "config") });
    expect(standard.value.agents).toHaveLength(15);
    expect(() => validateRoster(standard.value, content, standard.source)).not.toThrow();

    const core = loadRoster("core-3", { configDir: resolve(repoRoot, "config") });
    expect(core.value.agents).toHaveLength(3);
    expect(() => validateRoster(core.value, content, core.source)).not.toThrow();
  });

  it("超过 15 个身份的名册在 schema 层被拒绝", () => {
    expect(() => loadRoster("roster-21", { configDir: fixturesConfigDir })).toThrow(
      /名册最多包含 15 个身份/,
    );
    expect(rosterSchema.safeParse({ schemaVersion: 1, rosterId: "x", agents: [] }).success).toBe(false);
  });

  it("重复身份与类别不匹配在交叉检查层被拒绝", () => {
    const duplicate: Roster = {
      schemaVersion: 1,
      rosterId: "duplicate",
      agents: [
        { agentId: "npc-wenzhao", kind: "character", profileRef: "agent-character-default", toolsetRef: "character-default" },
        { agentId: "npc-wenzhao", kind: "character", profileRef: "agent-character-default", toolsetRef: "character-default" },
      ],
    };
    const duplicateError = captureLoadingError(() => validateRoster(duplicate, content));
    expect(duplicateError.path).toBe("agents.1.agentId");
    expect(duplicateError.message).toContain("重复");

    const wrongKind: Roster = {
      schemaVersion: 1,
      rosterId: "wrong-kind",
      agents: [
        { agentId: "npc-wenzhao", kind: "strategic", profileRef: "agent-character-default", toolsetRef: "character-default" },
      ],
    };
    const kindError = captureLoadingError(() => validateRoster(wrongKind, content));
    expect(kindError.path).toBe("agents.0.kind");

    const unknown: Roster = {
      schemaVersion: 1,
      rosterId: "unknown",
      agents: [
        { agentId: "npc-nobody", kind: "character", profileRef: "agent-character-default", toolsetRef: "character-default" },
      ],
    };
    const unknownError = captureLoadingError(() => validateRoster(unknown, content));
    expect(unknownError.path).toBe("agents.0.agentId");
  });
});
