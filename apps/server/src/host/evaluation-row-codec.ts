/**
 * 核心职责：把存储行解码为评估读取使用的标量、JSON 与 run 摘要，并读出 RunSpec 的脚本选择。
 * 交互契约：输入任意文本/JSON 列的行记录，返回强类型值；缺失或类型不符时返回 null 或回退值。
 * 约束与禁忌：不执行查询、不写存储，也不把缺失值当成合法值返回。
 */
import type { Json, RunSummary } from "@world-prism/contracts";

/** 从 run 行读取字符串列；缺失时返回 null，避免把 undefined 当成合法值。 */
export function stringCell(row: Readonly<Record<string, unknown>>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberCell(row: Readonly<Record<string, unknown>>, column: string, fallback: number): number {
  const value = row[column];
  return typeof value === "number" ? value : fallback;
}

export function booleanCell(row: Readonly<Record<string, unknown>>, column: string): boolean {
  return numberCell(row, column, 0) !== 0;
}

/** JSON 列可能以字符串或已解析对象返回，统一解码；解码失败返回 null 而不是抛出。 */
export function jsonCell(row: Readonly<Record<string, unknown>>, column: string): Json | null {
  const value = row[column];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return null;
    }
  }
  return value === undefined ? null : (value as Json);
}

/** 把 run 行映射为控制台摘要；变体取自冻结 RunSpec 里的 variant.id。 */
export function runSummary(row: Readonly<Record<string, unknown>>): RunSummary {
  const spec = jsonCell(row, "run_spec_json");
  const specObject = typeof spec === "object" && spec !== null && !Array.isArray(spec)
    ? (spec as Readonly<Record<string, Json>>)
    : {};
  const variantValue = specObject["variant"];
  const variant = typeof variantValue === "object" && variantValue !== null && !Array.isArray(variantValue)
    ? (variantValue as Readonly<Record<string, Json>>)["id"]
    : null;
  return {
    runId: stringCell(row, "run_id") ?? "",
    status: stringCell(row, "status") ?? "created",
    variant: typeof variant === "string" ? variant : null,
    contaminated: booleanCell(row, "contaminated"),
    createdAt: stringCell(row, "created_at") ?? "",
  };
}

/** 从 run 的 RunSpec 中读出脚本章节与分支；实验规格未写脚本时返回 null。 */
export function scriptSelectionOf(row: Readonly<Record<string, unknown>>): { readonly scriptRef: string; readonly branch: string | null } | null {
  const spec = jsonCell(row, "run_spec_json");
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return null;
  const script = (spec as Readonly<Record<string, Json>>)["script"];
  if (typeof script !== "object" || script === null || Array.isArray(script)) return null;
  const record = script as Readonly<Record<string, Json>>;
  const scriptRef = record["scriptRef"];
  const branch = record["branch"];
  if (typeof scriptRef !== "string") return null;
  return { scriptRef, branch: typeof branch === "string" ? branch : null };
}
