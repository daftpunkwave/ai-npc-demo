/**
 * 校验资产检查器对清单覆盖、唯一性、kind 与 ID 对应、内容包版本对应、路径越界、
 * SVG 结构安全与内容包结构校验的判定。
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
    expect(mismatch?.message).toContain("0.2.0");
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

describe("SVG 结构安全", () => {
  it.each([
    ["script 元素", "<script>alert(1)</script>", "script"],
    ["事件处理器", '<circle onload="alert(1)"/>', "事件处理器"],
    ["远端引用", '<image href="https://example.com/x.png"/>', "不允许的引用"],
    ["CSS url()", '<rect style="fill:url(https://example.com/x.png)"/>', "CSS"],
    // 只排除已知危险协议会漏掉 javascript:/vbscript:/file: 与协议相对引用；
    // 这里固定白名单语义：除文档内片段外，任何带协议或 // 开头的引用都拒绝。
    ["javascript 协议", '<a xlink:href="javascript:alert(1)"><text>x</text></a>', "不允许的引用"],
    ["vbscript 协议", '<a href="vbscript:msgbox(1)"><text>x</text></a>', "不允许的引用"],
    ["file 协议", '<image href="file:///etc/passwd"/>', "不允许的引用"],
    ["协议相对引用", '<image href="//example.com/x.png"/>', "不允许的引用"],
    // 控制字符与反斜杠会让原始值不匹配协议前缀，却在浏览器里折叠成可执行协议或
    // 协议相对地址；协议判定之前必须拒绝这两类字符。
    ["制表符拆分的协议", '<a href="java&#9;script:alert(1)"><text>x</text></a>', "控制字符、字符引用或反斜杠"],
    ["换行拆分的协议", '<a href="java&#10;script:alert(1)"><text>x</text></a>', "控制字符、字符引用或反斜杠"],
    ["反斜杠网络路径", '<image href="\\\\example.com/x.png"/>', "控制字符、字符引用或反斜杠"],
  ])("拒绝包含%s的资产", (_label, injection, expectedMessage) => {
    const root = createFixture();
    const svgPath = join(root, "assets/world/grayharbor-relay.svg");
    const source = readFileSync(svgPath, "utf8");
    writeFileSync(svgPath, source.replace("</svg>", `${injection}</svg>`), "utf8");
    const report = checkAssets({ root });
    const unsafe = report.violations.find((violation) => violation.code === "asset-unsafe");
    expect(unsafe).toBeDefined();
    expect(unsafe?.message).toContain(expectedMessage);
    expect(unsafe?.message).toContain("assets/world/grayharbor-relay.svg");
  });

  it("允许文档内片段引用", () => {
    const root = createFixture();
    const svgPath = join(root, "assets/world/grayharbor-relay.svg");
    const source = readFileSync(svgPath, "utf8");
    writeFileSync(svgPath, source.replace("</svg>", '<use href="#marker"/></svg>'), "utf8");
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).not.toContain("asset-unsafe");
  });
});

describe("资产路径越界与文件校验", () => {
  it.each([
    ["上级目录", "../package.json"],
    ["绝对路径", "/etc/grayharbor-relay.svg"],
    ["URL 协议", "https://example.com/x.svg"],
    ["反斜杠分隔", "assets\\world\\grayharbor-relay.svg"],
  ])("拒绝%s声明的资产路径", (_label, path) => {
    const root = createFixture();
    updateManifest(root, (manifest) => {
      const location = manifest.assets.find((asset) => asset["kind"] === "location");
      if (location === undefined) {
        throw new Error("测试夹具缺少地点资产");
      }
      location["path"] = path;
    });
    const report = checkAssets({ root });
    const invalid = report.violations.find((violation) => violation.code === "asset-path");
    expect(invalid).toBeDefined();
    expect(invalid?.message).toContain(path);
  });

  it("声明的资产文件为空时失败", () => {
    const root = createFixture();
    writeFileSync(join(root, "assets/world/grayharbor-relay.svg"), "", "utf8");
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("asset-empty");
  });
});

describe("内容包结构校验", () => {
  /** 替换临时内容包中的单个 YAML 文件文本后写回。 */
  function rewritePackFile(root: string, fileName: string, transform: (source: string) => string): void {
    const filePath = join(root, `content/world-packs/earth-2964-v1/${fileName}`);
    writeFileSync(filePath, transform(readFileSync(filePath, "utf8")), "utf8");
  }

  it("packId 与内容包目录名不一致时失败", () => {
    const root = createFixture();
    rewritePackFile(root, "pack.yaml", (source) =>
      source.replace("packId: earth-2964-v1", "packId: other-pack"),
    );
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("pack-id-mismatch");
  });

  it("pack.yaml schemaVersion 非 1 时失败", () => {
    const root = createFixture();
    rewritePackFile(root, "pack.yaml", (source) =>
      source.replace("schemaVersion: 1", "schemaVersion: 2"),
    );
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("pack-invalid");
  });

  it("map.yaml 出现重复 nodeId 时失败", () => {
    const root = createFixture();
    rewritePackFile(root, "map.yaml", (source) =>
      source.replace("- { nodeId: watergate,", "- { nodeId: grayharbor,"),
    );
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("node-duplicate");
  });

  it("内容包节点数与期望不符时失败", () => {
    const root = createFixture();
    rewritePackFile(root, "map.yaml", (source) => source.replace(/^.*nodeId: anchor.*\n/m, ""));
    const report = checkAssets({ root });
    expect(report.violations.map((violation) => violation.code)).toContain("node-count");
  });
});
