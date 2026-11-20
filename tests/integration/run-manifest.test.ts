/**
 * 验证 manifest 冻结字段、kernel 规范化哈希的键序无关性与配置敏感性，以及规则随机源向量。
 * 依赖真实内容包、仓库配置、kernel 解析与摘要函数；不启动宿主、不打开存储。
 * 禁止用原始 JSON.stringify 或截断摘要作为期望值，也禁止把随机 ID 混入随机输入。
 */
import { describe, expect, it } from "vitest";
import type { AssemblyDescriptor, Json } from "@ai-npc/contracts";
import { loadContentPack, loadRoster, loadRunSpec } from "@ai-npc/experiment";
import {
  buildRunManifest,
  loadAssembly,
  resolveServerAssembly,
  rngFor,
  serverModuleDefinitions,
} from "@ai-npc/app-server";

const loadContext = { configDir: "config" };
const content = loadContentPack("content", "earth-2964-v1");
const roster = loadRoster("standard-15", loadContext);
const runSpec = loadRunSpec("online-default", loadContext, {
  seed: "run-seed-test",
  moduleAssemblyRef: "local-slg-standard-v1",
}).value;

function clockConfig(assembly: AssemblyDescriptor): Json {
  const value = assembly.configs["clock"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("测试装配缺少 clock 配置");
  }
  return value;
}

function withClock(assembly: AssemblyDescriptor, clock: Readonly<Record<string, Json>>): AssemblyDescriptor {
  return { ...assembly, configs: { ...assembly.configs, clock: { ...clock } } };
}

function clockOf(assembly: AssemblyDescriptor): Readonly<Record<string, Json>> {
  return clockConfig(assembly) as Readonly<Record<string, Json>>;
}

function configValue(config: Readonly<Record<string, Json>>, key: string): Json {
  const value = config[key];
  if (value === undefined) {
    throw new Error(`测试装配的 clock 配置缺少 ${key}`);
  }
  return value;
}

async function manifestFor(assembly: AssemblyDescriptor) {
  const resolved = await resolveServerAssembly(assembly, serverModuleDefinitions);
  const built = await buildRunManifest({
    runSpec,
    content: { packId: content.pack.packId, contentVersion: content.pack.contentVersion },
    roster: roster.value,
    resolved,
  });
  return { resolved, built };
}

function randomVector(rng: () => number, count: number): readonly number[] {
  return Array.from({ length: count }, () => rng());
}

describe("规则随机源 rngFor", () => {
  it("同一 seed 与同一组语义字段得到相同随机向量", () => {
    const first = randomVector(rngFor("run-seed-1", "risk", "team-star", "4", "r-gh-or"), 8);
    const second = randomVector(rngFor("run-seed-1", "risk", "team-star", "4", "r-gh-or"), 8);
    expect(second).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    // sha256 前 8 个十六进制字符 + mulberry32 的已知向量，锁定规则第 11 节的算法。
    expect(first.slice(0, 3)).toEqual([0.04031090624630451, 0.7576795371714979, 0.08992389938794076]);
  });

  it("不同 seed 或不同语义字段得到不同随机向量", () => {
    const baseline = randomVector(rngFor("run-seed-1", "risk", "team-star", "4", "r-gh-or"), 8);
    expect(randomVector(rngFor("run-seed-2", "risk", "team-star", "4", "r-gh-or"), 8)).not.toEqual(baseline);
    expect(randomVector(rngFor("run-seed-1", "risk", "team-star", "5", "r-gh-or"), 8)).not.toEqual(baseline);
    expect(randomVector(rngFor("run-seed-1", "risk", "team-star", "4", "r-or-gh"), 8)).not.toEqual(baseline);
  });
});

describe("manifest 冻结与规范化哈希", () => {
  it("键书写顺序不影响模块配置、装配与 manifest 哈希", async () => {
    const assembly = loadAssembly("local-slg-standard-v1");
    const clock = clockOf(assembly);
    const reordered = withClock(assembly, {
      maxStepTicks: configValue(clock, "maxStepTicks"),
      autoPauseAfterDisconnectMs: configValue(clock, "autoPauseAfterDisconnectMs"),
      secondsPerTick: configValue(clock, "secondsPerTick"),
    });
    const base = await manifestFor(assembly);
    const reversed = await manifestFor(reordered);
    expect(reversed.resolved.assemblyHash).toBe(base.resolved.assemblyHash);
    expect(reversed.resolved.modules).toEqual(base.resolved.modules);
    expect(reversed.built.manifestHash).toBe(base.built.manifestHash);
  });

  it("有效配置变化会改变模块、装配与 manifest 哈希", async () => {
    const assembly = loadAssembly("local-slg-standard-v1");
    const changed = withClock(assembly, { ...clockOf(assembly), secondsPerTick: 30 });
    const base = await manifestFor(assembly);
    const tweaked = await manifestFor(changed);
    const clockHash = (result: typeof base): string | undefined =>
      result.resolved.modules.modules.find((module) => module.moduleId === "game.clock.controlled")?.configHash;
    expect(clockHash(tweaked)).not.toBe(clockHash(base));
    expect(tweaked.resolved.assemblyHash).not.toBe(base.resolved.assemblyHash);
    expect(tweaked.built.manifestHash).not.toBe(base.built.manifestHash);
  });

  it("冻结实际装配引用、内容版本、seed 与模块配置", async () => {
    const assembly = loadAssembly("local-slg-escalating-v1");
    const escalatingRun = loadRunSpec("online-default", loadContext, {
      seed: "escalating-seed",
      moduleAssemblyRef: assembly.assemblyId,
    }).value;
    const resolved = await resolveServerAssembly(assembly, serverModuleDefinitions);
    const built = await buildRunManifest({
      runSpec: escalatingRun,
      content: { packId: content.pack.packId, contentVersion: content.pack.contentVersion },
      roster: roster.value,
      resolved,
    });
    expect(built.manifest).toMatchObject({
      seed: "escalating-seed",
      selection: { moduleAssemblyRef: "local-slg-escalating-v1", rosterRef: "standard-15" },
      content: { packId: "earth-2964-v1", contentVersion: "0.2.0" },
      assembly: { assemblyId: "local-slg-escalating-v1", realm: "server", assemblyHash: resolved.assemblyHash },
      agentSlots: null,
    });
    expect(
      built.manifest.assembly.modules.some((module) => module.moduleId === "game.scenario.watergate-escalating"),
    ).toBe(true);
    expect(built.manifest.assembly.modules.every((module) => module.configHash.length === 64)).toBe(true);
    expect(built.manifest.assembly.modules.find((module) => module.moduleId === "game.clock.controlled")?.config).toMatchObject({
      secondsPerTick: 20,
      maxStepTicks: 24,
    });
    expect(built.manifestHash.length).toBe(64);
  });
});
