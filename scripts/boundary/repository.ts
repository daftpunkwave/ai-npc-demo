/**
 * 仓库扫描：解析 workspace 包清单与源码文件，供 CLI 与仓库级检查复用。
 * 只读取 pnpm workspace 声明、package.json 与手写源码文本，不执行被检查代码。
 * 禁止扫描依赖目录、生成产物或测试夹具，也禁止在缺少清单时静默返回空结果。
 */
/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename -- 只读取仓库根目录与 workspace/package.json 清单，键与路径均来自固定清单或 readdir 结果。 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { HEADER_LANGUAGE_BY_EXTENSION } from "./constants";
import { checkBoundaries } from "./checker";
import { isSkippedDirectory, normalizeRepoPath } from "./paths";
import type { BoundaryCheckInput, BoundaryPackage, BoundarySourceFile, BoundaryViolation } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

/** 只保留 exports 的入口名；条件导出等非字符串值按“已声明入口”处理。 */
function readExports(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(asRecord(value))) {
    result[key] = typeof entry === "string" ? entry : "";
  }
  return result;
}

function readWorkspaceGlobs(root: string): string[] {
  const workspacePath = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    throw new Error(`缺少 workspace 清单：${workspacePath}`);
  }
  const globs: string[] = [];
  let inPackagesSection = false;
  for (const line of readFileSync(workspacePath, "utf8").split(/\r?\n/)) {
    if (line.length > 0 && !/^\s/.test(line)) {
      inPackagesSection = /^packages\s*:/.test(line);
      continue;
    }
    if (!inPackagesSection) {
      continue;
    }
    // eslint-disable-next-line security/detect-unsafe-regex -- 输入是 workspace 清单的单行文本，模式无嵌套量词。
    const match = /^\s*-\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line);
    const glob = match?.[1];
    if (glob !== undefined) {
      globs.push(glob);
    }
  }
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml 的 packages 段为空。");
  }
  return globs;
}

function expandWorkspaceGlob(root: string, glob: string): string[] {
  const segments = glob.split("/").filter((segment) => segment !== "");
  let current: string[] = [""];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === "*") {
        const absoluteDirectory = base === "" ? root : join(root, base);
        if (!existsSync(absoluteDirectory)) {
          continue;
        }
        for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            next.push(base === "" ? entry.name : `${base}/${entry.name}`);
          }
        }
      } else if (segment.includes("*")) {
        throw new Error(`workspace 通配符只支持整段 *：${glob}`);
      } else {
        next.push(base === "" ? segment : `${base}/${segment}`);
      }
    }
    current = next;
  }
  return current.filter((directory) => existsSync(join(root, directory, "package.json")));
}

function readPackageManifest(root: string, directory: string): BoundaryPackage {
  const manifestPath = join(root, directory, "package.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  const record = asRecord(parsed);
  const name = record["name"];
  if (typeof name !== "string" || name === "") {
    throw new Error(`包清单缺少 name：${manifestPath}`);
  }
  return {
    name,
    directory: normalizeRepoPath(directory),
    dependencies: readStringRecord(record["dependencies"]),
    devDependencies: readStringRecord(record["devDependencies"]),
    exports: readExports(record["exports"]),
  };
}

function walkRepositoryFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (relativeDirectory: string): void => {
    const absoluteDirectory = relativeDirectory === "" ? root : join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const childRelative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(entry.name)) {
          walk(childRelative);
        }
      } else if (entry.isFile()) {
        files.push(childRelative);
      }
    }
  };
  walk("");
  return files.sort();
}

/** CLI 输入：解析 workspace 包清单，并收集需要检查文件头与 import 的源码文件。 */
export function scanRepository(root: string): BoundaryCheckInput {
  const absoluteRoot = resolve(root);
  const packageDirectories = new Set<string>();
  for (const glob of readWorkspaceGlobs(absoluteRoot)) {
    for (const directory of expandWorkspaceGlob(absoluteRoot, glob)) {
      packageDirectories.add(normalizeRepoPath(directory));
    }
  }
  if (packageDirectories.size === 0) {
    throw new Error(`未在 ${absoluteRoot} 找到 workspace 包。`);
  }
  const packages = [...packageDirectories]
    .sort()
    .map((directory) => readPackageManifest(absoluteRoot, directory));
  const files: BoundarySourceFile[] = [];
  for (const relativePath of walkRepositoryFiles(absoluteRoot)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
    if (HEADER_LANGUAGE_BY_EXTENSION[extname(relativePath).toLowerCase()] === undefined) {
      continue;
    }
    files.push({ path: relativePath, content: readFileSync(join(absoluteRoot, relativePath), "utf8") });
  }
  return { files, packages };
}

export function checkRepository(root: string): readonly BoundaryViolation[] {
  return checkBoundaries(scanRepository(root));
}
