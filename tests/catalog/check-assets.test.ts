/**
 * 校验资产检查器对清单覆盖、唯一性、kind 与 ID 对应及内容包版本对应的判定。
 * 夹具复制真实资产与内容包到临时目录，只改清单或内容包后直接调用可导入的校验函数。
 * 禁止只断言文件存在、跳过检查器或把失败夹具当作通过。
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkAssets, runAssetCheckCli } from "@ai-npc/scripts/check-assets";

interface ManifestFixture {
  schemaVersion: number;
  packId: string;
  contentVersion: string;
  assets: Array<Record<string, unknown>>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "asset-check-"));
  temporaryRoots.push(root);
  cpSync(join(repositoryRoot, "assets"), join(root, "assets"), { recursive: true });
  const packDirectory = join(root, "content/world-packs/earth-2964-v1");
  mkdirSync(packDirectory, { recursive: true });
  for (const fileName of ["map.yaml", "factions.yaml", "pack.yaml"]) {
    copyFileSync(
      join(repositoryRoot, "content/world-packs/earth-2964-v1", fileName),
      join(packDirectory, fileName),
    );
  }
  return root;
}

function updateManifest(root: string, mutate: (manifest: ManifestFixture) => void): void {
  const manifestPath = join(root, "assets/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestFixture;
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function firstAsset(manifest: ManifestFixture): Record<string, unknown> {
  const [first] = manifest.assets;
  if (first === undefined) {
    throw new Error("测试夹具缺少资产条目");
  }
  return first;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("资产清单覆盖与唯一性", () => {
  it("基线清单通过并覆盖六节点与八派系", () => {
    const root = createFixture();
    const report = checkAssets({ root });
    expect(report.violations).toEqual([]);
    expect(report.assetCount).toBe(14);
    expect(report.nodeCount).toBe(6);
    expect(report.factionCount).toBe(8);
  });

  it("清单移除一个节点资产时失败并指出未覆盖节点", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      const index = manifest.assets.findIndex((asset) => asset["nodeId"] === "archive");
      expect(index).toBeGreaterThanOrEqual(0);
      manifest.assets.splice(index, 1);
    });
    const report = checkAssets({ root });
    const codes = report.violations.map((violation) => violation.code);
    expect(codes).toContain("node-uncovered");
    expect(report.violations.some((violation) => violation.message.includes("archive"))).toBe(true);
  });

  it("重复 assetId 时失败", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      manifest.assets.push({ ...firstAsset(manifest) });
    });
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("asset-duplicate-id");
  });

  it("kind 与 assetId 前缀不一致时失败", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      const location = manifest.assets.find((asset) => asset["kind"] === "location");
      if (location === undefined) {
        throw new Error("测试夹具缺少地点资产");
      }
      location["assetId"] = String(location["assetId"]).replace(/^world\./, "faction.");
    });
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("asset-id-prefix");
  });
});

describe("资产与内容包版本对应", () => {
  it("contentVersion 与内容包不一致时失败", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      manifest.contentVersion = "1.0.1";
    });
    const report = checkAssets({ root });
    const mismatch = report.violations.find((violation) => violation.code === "version-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain("1.0.1");
    expect(mismatch?.message).toContain("0.1.0");
  });

  it("CLI 在版本不一致时返回非零并打印原因", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      manifest.contentVersion = "1.0.1";
    });
    const stderr: string[] = [];
    const exitCode = runAssetCheckCli({
      root,
      writeStdout: () => undefined,
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("version-mismatch");
  });
});

describe("可选 preview 字段", () => {
  it("preview 指向的预览文件缺失时失败", () => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      const location = manifest.assets.find((asset) => asset["kind"] === "location");
      if (location === undefined) {
        throw new Error("测试夹具缺少地点资产");
      }
      location["preview"] = "assets/previews/grayharbor-relay.png";
    });
    expect(checkAssets({ root }).violations).toEqual([]);

    rmSync(join(root, "assets/previews/grayharbor-relay.png"));
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("preview-missing");
  });
});
