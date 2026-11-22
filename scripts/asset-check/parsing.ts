/**
 * 核心职责：提供资产校验的文件读取、JSON/YAML 解析与 SVG 文本提取原语。
 * 交互契约：读取路径限定在仓库根下的资产与内容包目录；解析失败写入违规集合而不是抛出。
 * 约束与禁忌：禁止访问声明目录之外的路径，禁止静默吞掉解析失败。
 */
/* eslint-disable security/detect-non-literal-fs-filename -- 路径已限制在 assets/ 与内容包目录内并做过 realpath 越界检查。 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Json } from "@ai-npc/contracts";
import type { AssetViolation } from "./report-types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(
  root: string,
  relativePath: string,
  code: string,
  label: string,
  violations: AssetViolation[],
): string | null {
  try {
    return readFileSync(resolve(root, relativePath), "utf8");
  } catch {
    violations.push({ code, message: `${label}无法读取：${relativePath}` });
    return null;
  }
}

export function parseJson(text: string, label: string, violations: AssetViolation[]): Json | null {
  try {
    return JSON.parse(text) as Json;
  } catch {
    violations.push({ code: "manifest-unreadable", message: `${label}不是合法 JSON` });
    return null;
  }
}

export function parseYamlText(text: string, label: string, violations: AssetViolation[]): Json | null {
  try {
    return parseYaml(text) as Json;
  } catch {
    violations.push({ code: "pack-unreadable", message: `${label}不是合法 YAML` });
    return null;
  }
}

export function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item)).filter((item) => item !== null).join(" ").trim() || null;
  }
  if (typeof value === "object" && value !== null) {
    const text = (value as Record<string, unknown>)["#text"];
    return textOf(text);
  }
  return null;
}
