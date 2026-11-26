/**
 * 核心职责：验证实验规格的加载、run 展开顺序与交叉校验的拒绝路径。
 * 交互契约：使用仓库内真实配置、内容包与名册；临时目录只用于构造非法规格。
 * 约束与禁忌：断言必须覆盖展开数量、顺序、配对 seed 与每类配置错误的可定位信息。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProfilePatch,
  expandExperimentRuns,
  loadAgentProfile,
  loadContentPack,
  loadExperimentSpec,
  loadRoster,
  loadRunSpec,
  validateExperimentSpec,
  type ExperimentSpec,
} from "@world-prism/experiment";

const configDir = resolve("config");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 在临时目录里写一份实验规格；只复制必要的 config 结构用于覆盖非法字段。 */
function specWith(mutate: (spec: Record<string, unknown>) => void, name = "exp-temp"): ExperimentSpec {
  const root = mkdtempSync(join(tmpdir(), "world-prism-experiment-"));
  roots.push(root);
  const spec = {
    schemaVersion: 1,
    experimentId: name,
    base: {
      moduleAssemblyRef: "local-slg-test-v1",
      worldPackRef: "earth-2964-v1",
      scenarioRef: "watergate-v1",
      rosterRef: "core-3",
      modelLayoutRef: "deterministic-model-layout-v1",
      seed: name,
      player: { principalId: "player-1", factionId: "human-neutral" },
      mode: "closed-loop",
      initialState: { kind: "cold-start" },
      clock: { kind: "controlled" },
      budget: { maxTokens: 500000, maxCost: null },
      failurePolicy: "strict",
    },
    scriptRef: "s-promise",
    scriptBranches: ["keep", "break"],
    commonPatchRefs: [],
    variants: ["memory-m0-window"],
    repetitions: 1,
    runOrder: "sequential",
  };
  mutate(spec);
  writeFileSync(join(root, `${name}.yaml`), JSON.stringify(spec), "utf8");
  return loadExperimentSpec(name, { configDir: root }).value;
}

const content = loadContentPack("content", "earth-2964-v1");
const roster = loadRoster("core-3", { configDir }).value;

describe("实验规格加载与展开", () => {
  it("三个仓库实验规格都可加载并与内容、名册交叉校验通过", () => {
    for (const name of ["exp-memory-promise-v1", "exp-memory-rumor-v1", "exp-memory-secret-v1"]) {
      const spec = loadExperimentSpec(name, { configDir }).value;
      expect(spec.experimentId).toBe(name);
      expect(() => validateExperimentSpec(spec, content, roster, { configDir })).not.toThrow();
    }
  });

  it("承诺实验按变体 × 分支 × 重复展开为 24 个 run", () => {
    const spec = loadExperimentSpec("exp-memory-promise-v1", { configDir }).value;
    const runs = expandExperimentRuns(spec);
    expect(runs).toHaveLength(spec.variants.length * spec.scriptBranches.length * spec.repetitions);
    expect(runs).toHaveLength(24);
    // 每个变体 × 分支组合各出现 repetitions 次。
    const counts = new Map<string, number>();
    for (const run of runs) {
      const key = `${run.variantRef}/${run.scriptBranch}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((count) => count === spec.repetitions)).toBe(true);
    expect(counts.size).toBe(spec.variants.length * spec.scriptBranches.length);
  });

  it("同一次重复的各变体共享 seed，不同重复之间 seed 不同", () => {
    const spec = loadExperimentSpec("exp-memory-promise-v1", { configDir }).value;
    const runs = expandExperimentRuns(spec);
    for (const repetition of [1, 2, 3]) {
      const seeds = new Set(runs.filter((run) => run.repetition === repetition).map((run) => run.seed));
      expect(seeds.size).toBe(1);
      expect([...seeds][0]).toBe(`${spec.base.seed}:rep${repetition}`);
    }
    expect(new Set(runs.map((run) => run.seed)).size).toBe(spec.repetitions);
  });

  it("runOrder 为 rotate 时每个重复的变体起点依次后移", () => {
    const spec = loadExperimentSpec("exp-memory-promise-v1", { configDir }).value;
    const runs = expandExperimentRuns(spec);
    const firstVariantOf = (repetition: number): string | undefined =>
      runs.find((run) => run.repetition === repetition)?.variantRef;
    expect(firstVariantOf(1)).toBe(spec.variants[0]);
    expect(firstVariantOf(2)).toBe(spec.variants[1]);
    expect(firstVariantOf(3)).toBe(spec.variants[2]);
    // 轮转是置换：同一重复内的变体集合仍与声明一致。
    for (const repetition of [1, 2, 3]) {
      const variants = new Set(runs.filter((run) => run.repetition === repetition).map((run) => run.variantRef));
      expect([...variants].sort()).toEqual([...spec.variants].sort());
    }
  });

  it("没有命名分支的脚本每个变体只展开一次", () => {
    const spec = loadExperimentSpec("exp-memory-rumor-v1", { configDir }).value;
    expect(spec.scriptBranches).toEqual([]);
    const runs = expandExperimentRuns(spec);
    expect(runs).toHaveLength(spec.variants.length * spec.repetitions);
    // 无分支时 scriptBranch 为 null，不伪造任何可能撞上真实分支名的占位值。
    expect(runs.every((run) => run.scriptBranch === null)).toBe(true);
  });

  it("脚本声明了分支时实验规格不能留空", () => {
    const spec = specWith((value) => {
      value["scriptBranches"] = [];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/声明了分支 keep、break，实验规格不能留空/u);
  });

  it("重复声明的脚本分支被拒绝", () => {
    const spec = specWith((value) => {
      value["scriptBranches"] = ["keep", "keep"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/scriptBranches\.1.*重复声明/u);
  });

  it("公共补丁先叠加到基线，变体再叠加在其上", () => {
    // decision-deterministic 把 decision 槽换成确定性决策；变体只改 memory 槽。
    // 若把变体独立叠加到基线（而不是公共补丁的结果），下面的断言就会失败。
    const spec = specWith((value) => {
      value["commonPatchRefs"] = ["decision-deterministic"];
      value["variants"] = ["memory-m1-structured-ledger"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir })).not.toThrow();
    const profile = applyProfilePatch(
      applyProfilePatch(loadAgentProfile("agent-strategic-default", { configDir }), "decision-deterministic", { configDir }),
      "memory-m1-structured-ledger",
      { configDir },
    );
    expect(profile.slots.decision?.module).toBe("agent.decision.deterministic");
    expect(profile.slots.memory?.module).toBe("agent.memory.ledger");
  });

  it("公共补丁本身不可解析时指出其位置", () => {
    const spec = specWith((value) => {
      value["commonPatchRefs"] = ["no-such-patch"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/commonPatchRefs\.0.*no-such-patch/u);
  });

  it("轮转在重复次数超过变体数时按模数回绕，且每次重复都含全部变体", () => {
    // 轮转偏移超过数组长度时必须取模回绕，否则第一组会越界取到 undefined。
    const spec = specWith((value) => {
      value["variants"] = ["memory-m0-window", "memory-m1-structured-ledger"];
      value["repetitions"] = 5;
      value["runOrder"] = "rotate";
    });
    const runs = expandExperimentRuns(spec);
    // 变体 2 × 分支 2 × 重复 5。
    expect(runs).toHaveLength(2 * spec.scriptBranches.length * 5);
    // 偏移 0..4 对长度 2 取模后起点在两组之间交替。
    for (const repetition of [1, 2, 3, 4, 5]) {
      const first = runs.find((run) => run.repetition === repetition)?.variantRef;
      expect(first).toBe(repetition % 2 === 1 ? "memory-m0-window" : "memory-m1-structured-ledger");
      const variants = new Set(runs.filter((run) => run.repetition === repetition).map((run) => run.variantRef));
      expect(variants.size).toBe(2);
    }
    // 任何一次重复都不应产出 undefined 变体。
    expect(runs.every((run) => typeof run.variantRef === "string" && run.variantRef.length > 0)).toBe(true);
  });

  it("只有一个变体时轮转不改变顺序", () => {
    const spec = specWith((value) => {
      value["variants"] = ["memory-m0-window"];
      value["repetitions"] = 3;
      value["runOrder"] = "rotate";
    });
    const runs = expandExperimentRuns(spec);
    // 每个重复都产出「变体 × 分支」组合，且变体恒为唯一那一个。
    expect(runs).toHaveLength(3 * spec.scriptBranches.length);
    expect(new Set(runs.map((run) => run.variantRef))).toEqual(new Set(["memory-m0-window"]));
  });

  it("变体补丁排在公共补丁之后", () => {
    const spec = specWith((value) => {
      value["commonPatchRefs"] = ["decision-deterministic"];
    });
    const [run] = expandExperimentRuns(spec);
    expect(run?.profilePatchRefs).toEqual(["decision-deterministic", "memory-m0-window"]);
  });

  it("以测试装配、确定性布局与决策补丁展开的 RunSpec 可被现有校验接受", () => {
    // 这条用例把实验规格与既有 RunSpec 校验接起来：模板字段必须足以构造合法 RunSpec。
    const spec = specWith((value) => {
      value["commonPatchRefs"] = ["decision-deterministic"];
    });
    const [run] = expandExperimentRuns(spec);
    const loaded = loadRunSpec("online-model-test", { configDir }, {
      seed: run?.seed,
      moduleAssemblyRef: spec.base.moduleAssemblyRef,
      worldPackRef: spec.base.worldPackRef,
      rosterRef: spec.base.rosterRef,
      modelLayoutRef: spec.base.modelLayoutRef,
    });
    expect(loaded.value.seed).toBe("exp-temp:rep1");
    expect(loaded.value.rosterRef).toBe("core-3");
  });
});

describe("实验规格交叉校验", () => {
  it("脚本分支不存在时拒绝并指明字段路径", () => {
    const spec = specWith((value) => {
      value["scriptBranches"] = ["keep", "no-such-branch"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/scriptBranches\.1.*没有分支/u);
  });

  it("脚本不存在时拒绝", () => {
    const spec = specWith((value) => {
      value["scriptRef"] = "s-missing";
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/脚本「s-missing」不存在/u);
  });

  it("变体补丁无法解析时拒绝并指明是哪个变体", () => {
    const spec = specWith((value) => {
      value["variants"] = ["memory-m0-window", "no-such-variant"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/variants\.1.*no-such-variant/u);
  });

  it("变体重复时拒绝", () => {
    const spec = specWith((value) => {
      value["variants"] = ["memory-m0-window", "memory-m0-window"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/变体重复/u);
  });

  it("变体同时出现在公共补丁中时拒绝", () => {
    const spec = specWith((value) => {
      value["commonPatchRefs"] = ["memory-m0-window"];
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/变体不能同时出现在公共补丁中/u);
  });

  it("名册引用与已加载名册不一致时拒绝", () => {
    const spec = specWith((value) => {
      const base = value["base"] as Record<string, unknown>;
      base["rosterRef"] = "standard-15";
      value["scriptRef"] = "s-promise";
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/名册引用「standard-15」与已加载名册「core-3」不一致/u);
  });

  it("剧情不存在时拒绝", () => {
    const spec = specWith((value) => {
      const base = value["base"] as Record<string, unknown>;
      base["scenarioRef"] = "no-such-scenario";
    });
    expect(() => validateExperimentSpec(spec, content, roster, { configDir }))
      .toThrowError(/剧情「no-such-scenario」不存在/u);
  });

  it("未知字段被严格拒绝", () => {
    const root = mkdtempSync(join(tmpdir(), "world-prism-experiment-"));
    roots.push(root);
    // base 必须完整，否则 schema 会先报缺字段，测不到「拒绝未知字段」这一条。
    writeFileSync(join(root, "exp-extra.yaml"), JSON.stringify({
      schemaVersion: 1,
      experimentId: "exp-extra",
      base: validTemplate(),
      scriptRef: "s-promise",
      scriptBranches: [],
      commonPatchRefs: [],
      variants: ["memory-m0-window"],
      repetitions: 1,
      runOrder: "sequential",
      unknownField: true,
    }), "utf8");
    expect(() => loadExperimentSpec("exp-extra", { configDir: root })).toThrowError(/unrecognized|Unrecognized/u);
  });

  it("实验 ID 与文件引用不一致时拒绝", () => {
    const root = mkdtempSync(join(tmpdir(), "world-prism-experiment-"));
    roots.push(root);
    // base 完整，使加载走到 ID 比对而不是先被 schema 拒绝。
    writeFileSync(join(root, "exp-renamed.yaml"), JSON.stringify({
      schemaVersion: 1,
      experimentId: "exp-other",
      base: validTemplate(),
      scriptRef: "s-promise",
      scriptBranches: [],
      commonPatchRefs: [],
      variants: ["memory-m0-window"],
      repetitions: 1,
      runOrder: "sequential",
    }), "utf8");
    expect(() => loadExperimentSpec("exp-renamed", { configDir: root }))
      .toThrowError(/实验 ID「exp-other」与引用「exp-renamed」不一致/u);
  });
});

/** 一份字段完整、可用于构造非法规格的 RunSpec 模板。 */
function validTemplate(): Record<string, unknown> {
  return {
    moduleAssemblyRef: "local-slg-test-v1",
    worldPackRef: "earth-2964-v1",
    scenarioRef: "watergate-v1",
    rosterRef: "core-3",
    modelLayoutRef: "deterministic-model-layout-v1",
    seed: "exp-temp",
    player: { principalId: "player-1", factionId: "human-neutral" },
    mode: "closed-loop",
    initialState: { kind: "cold-start" },
    clock: { kind: "controlled" },
    budget: { maxTokens: 500000, maxCost: null },
    failurePolicy: "strict",
  };
}
