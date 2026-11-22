/**
 * 核心职责：读取并校验内容包 pack.yaml 与节点、派系标识清单。
 * 交互契约：只接受内容包目录内的固定文件名；结构违规写入违规集合并返回 null。
 * 约束与禁忌：禁止访问内容包目录之外的路径，禁止把缺失或重复 ID 当作通过。
 */
import { basename } from "node:path";
import type { AssetViolation } from "./report-types";
import { isRecord, parseYamlText, readText } from "./parsing";

const CONTENT_PACK_DIRECTORY = "content/world-packs/earth-2964-v1";
const EXPECTED_NODE_COUNT = 6;
const EXPECTED_FACTION_COUNT = 8;

export interface ContentPack {
  readonly packId: string;
  readonly contentVersion: string;
  readonly nodeIds: ReadonlySet<string>;
  readonly factionIds: ReadonlySet<string>;
}

/** 读取内容包 ID 列表所需的输入；只接受内容包目录内的固定文件名。 */
interface IdentifierListInput {
  readonly root: string;
  readonly fileName: string;
  readonly listField: string;
  readonly idField: string;
  readonly expectedCount: number;
  readonly countCode: string;
  readonly duplicateCode: string;
  readonly label: string;
}

function readIdentifierList(
  input: IdentifierListInput,
  violations: AssetViolation[],
): ReadonlySet<string> | null {
  const { root, fileName, listField, idField, expectedCount, countCode, duplicateCode, label } = input;
  const relativePath = `${CONTENT_PACK_DIRECTORY}/${fileName}`;
  const text = readText(root, relativePath, "pack-unreadable", `内容包 ${fileName}`, violations);
  if (text === null) {
    return null;
  }
  const value = parseYamlText(text, `内容包 ${fileName}`, violations);
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} 根节点必须是映射` });
    return null;
  }
  if (value["schemaVersion"] !== 1) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} schemaVersion 必须为 1` });
    return null;
  }
  const list = value[listField];
  if (!Array.isArray(list)) {
    violations.push({ code: "pack-invalid", message: `内容包 ${fileName} 缺少数组 ${listField}` });
    return null;
  }
  const ids = new Set<string>();
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) {
      violations.push({ code: "pack-invalid", message: `内容包 ${fileName} ${listField}[${index}] 必须是映射` });
      continue;
    }
    const rawId = item[idField];
    if (typeof rawId !== "string" || rawId.trim() === "") {
      violations.push({ code: "pack-invalid", message: `内容包 ${fileName} ${listField}[${index}] 缺少非空字符串 ${idField}` });
      continue;
    }
    if (ids.has(rawId)) {
      violations.push({ code: duplicateCode, message: `内容包 ${fileName} 重复 ${idField}：${rawId}` });
    }
    ids.add(rawId);
  }
  if (list.length !== expectedCount) {
    violations.push({
      code: countCode,
      message: `内容包 ${fileName} 应包含 ${expectedCount} 个${label}，实际 ${list.length} 个`,
    });
  }
  return ids;
}

export function loadContentPack(root: string, violations: AssetViolation[]): ContentPack | null {
  const relativePath = `${CONTENT_PACK_DIRECTORY}/pack.yaml`;
  const text = readText(root, relativePath, "pack-unreadable", "内容包 pack.yaml", violations);
  if (text === null) {
    return null;
  }
  const value = parseYamlText(text, "内容包 pack.yaml", violations);
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 根节点必须是映射" });
    return null;
  }
  if (value["schemaVersion"] !== 1) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml schemaVersion 必须为 1" });
    return null;
  }
  const packId = value["packId"];
  if (typeof packId !== "string" || packId.trim() === "") {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 缺少非空 packId" });
    return null;
  }
  const contentVersion = value["contentVersion"];
  if (typeof contentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(contentVersion)) {
    violations.push({ code: "pack-invalid", message: "内容包 pack.yaml 的 contentVersion 必须形如 1.0.0" });
    return null;
  }
  if (packId !== basename(CONTENT_PACK_DIRECTORY)) {
    violations.push({
      code: "pack-id-mismatch",
      message: `内容包目录名 ${basename(CONTENT_PACK_DIRECTORY)} 与 pack.yaml 的 packId ${packId} 不一致`,
    });
  }
  const nodeIds = readIdentifierList(
    {
      root,
      fileName: "map.yaml",
      listField: "nodes",
      idField: "nodeId",
      expectedCount: EXPECTED_NODE_COUNT,
      countCode: "node-count",
      duplicateCode: "node-duplicate",
      label: "节点",
    },
    violations,
  );
  const factionIds = readIdentifierList(
    {
      root,
      fileName: "factions.yaml",
      listField: "factions",
      idField: "factionId",
      expectedCount: EXPECTED_FACTION_COUNT,
      countCode: "faction-count",
      duplicateCode: "faction-duplicate",
      label: "派系",
    },
    violations,
  );
  if (nodeIds === null || factionIds === null) {
    return null;
  }
  return { packId, contentVersion, nodeIds, factionIds };
}
