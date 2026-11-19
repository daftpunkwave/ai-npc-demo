/**
 * 解析 profile 继承链与 variant patch 叠加：父级在前合并、slots 按槽整块替换、其他顶层键整键替换。
 * 依赖公共契约的 JSON 值、DomainError 与 zod 结构校验；输入为配置加载器后续提供的已校验文档形状。
 * 禁止深合并槽内配置、按文件加载顺序决定优先级，或放过继承环与非法 variant 声明。
 */
import { z } from "zod";
import { DomainError, jsonValueSchema, type Json } from "@ai-npc/contracts";

/** profile 的层级类别：基线、场景、Agent 配方与实验 variant。 */
export const profileKindSchema = z.enum(["platform", "scene", "agent", "variant"]);

export type ProfileKind = z.infer<typeof profileKindSchema>;

/** 单个槽位选择：模块 ID 与该槽的完整配置块。 */
export const profileSlotSchema = z.strictObject({
  module: z.string().min(1),
  config: jsonValueSchema.default({}),
});

export type ProfileSlot = z.infer<typeof profileSlotSchema>;

const profileMetadataKeys = new Set(["schemaVersion", "profileId", "kind", "parent", "slots", "patch"]);

/**
 * 通用 profile 文档：元数据与 slots 有固定结构，其余顶层键保留为可整键替换的策略设置。
 * variant 用 patch 表达覆盖；其余类别用 slots 与顶层设置表达本层内容。
 */
export const profileDocumentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    profileId: z.string().min(1),
    kind: profileKindSchema,
    parent: z.string().min(1).nullable().optional(),
    slots: z.record(z.string().min(1), profileSlotSchema).optional(),
    patch: z.record(z.string().min(1), jsonValueSchema).optional(),
  })
  .catchall(jsonValueSchema);

export type ProfileDocument = z.infer<typeof profileDocumentSchema>;

/** 解析一个 profile 的输入：全部文档、目标 profile 与按顺序叠加的 variant profile ID。 */
export interface ResolveProfileInput {
  readonly profiles: readonly ProfileDocument[];
  readonly profileId: string;
  readonly patchProfileIds?: readonly string[];
}

/** 解析结果：继承链、合并后的槽位、顶层设置与已应用的 patch 顺序。 */
export interface ResolvedProfile {
  readonly profileId: string;
  readonly kind: ProfileKind;
  readonly chain: readonly string[];
  readonly slots: Readonly<Record<string, ProfileSlot>>;
  readonly settings: Readonly<Record<string, Json>>;
  readonly appliedPatchIds: readonly string[];
}

function failProfile(message: string, details: Json): never {
  throw new DomainError("assembly-incompatible", message, { details });
}

function formatIssues(issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Codacy 的 Node10 解析无法识别 workspace 包的 exports 入口，把导入类型判成 any；实际类型不是 any。
function isJsonObject(value: Json | undefined): value is { readonly [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indexProfiles(profiles: readonly ProfileDocument[]): Map<string, ProfileDocument> {
  const byId = new Map<string, ProfileDocument>();
  for (const document of profiles) {
    if (byId.has(document.profileId)) {
      failProfile(`profile ${document.profileId} 重复定义`, { profileId: document.profileId });
    }
    byId.set(document.profileId, document);
  }
  return byId;
}

function normalizeSlot(profileId: string, slot: string, raw: unknown): ProfileSlot {
  const parsed = profileSlotSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error.issues);
    failProfile(`profile ${profileId} 的槽 ${slot} 配置非法：${issues.join("；")}`, { profileId, slot, issues });
  }
  return parsed.data;
}

/**
 * 从目标 profile 向上追溯父级，返回父级在前的继承链。
 * 用已访问位置表检测继承环，并在错误中给出完整环路。
 */
function resolveInheritanceChain(byId: ReadonlyMap<string, ProfileDocument>, profileId: string): readonly ProfileDocument[] {
  const path: ProfileDocument[] = [];
  const positions = new Map<string, number>();
  let current = byId.get(profileId);
  if (current === undefined) {
    failProfile(`profile ${profileId} 未定义`, { profileId });
  }
  for (;;) {
    const position = positions.get(current.profileId);
    if (position !== undefined) {
      const cycle = [...path.slice(position).map((document) => document.profileId), current.profileId];
      failProfile(`profile 继承链存在环：${cycle.join(" -> ")}`, { profileId: current.profileId, cycle });
    }
    if (current.kind === "variant") {
      failProfile(`variant profile ${current.profileId} 不能作为继承链成员`, { profileId: current.profileId });
    }
    if (current.patch !== undefined) {
      failProfile(`profile ${current.profileId} 不是 variant 却声明了 patch`, { profileId: current.profileId });
    }
    positions.set(current.profileId, path.length);
    path.push(current);
    const parentId = current.parent ?? null;
    if (parentId === null) {
      break;
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      failProfile(`profile ${current.profileId} 的父级 ${parentId} 未定义`, { profileId: current.profileId, parentId });
    }
    current = parent;
  }
  return path.reverse();
}

/** 父级在前合并：slots 按槽整块替换，其他顶层键整键替换，不做任何深合并。 */
function mergeChain(chain: readonly ProfileDocument[]): {
  readonly slots: Record<string, ProfileSlot>;
  readonly settings: Record<string, Json>;
} {
  const slots: Record<string, ProfileSlot> = {};
  const settings: Record<string, Json> = {};
  for (const document of chain) {
    for (const key of Object.keys(document)) {
      if (profileMetadataKeys.has(key)) {
        continue;
      }
      // eslint-disable-next-line security/detect-object-injection -- 键来自内容包配置的字段与槽位清单，只读合并。
      const value = document[key];
      if (value !== undefined) {
        // eslint-disable-next-line security/detect-object-injection -- 键来自内容包配置的字段与槽位清单，只读合并。
        settings[key] = value;
      }
    }
    const declaredSlots = document.slots;
    if (declaredSlots !== undefined) {
      for (const [slot, rawSelection] of Object.entries(declaredSlots)) {
        // eslint-disable-next-line security/detect-object-injection -- 键来自内容包配置的字段与槽位清单，只读合并。
        slots[slot] = normalizeSlot(document.profileId, slot, rawSelection);
      }
    }
  }
  return { slots, settings };
}

/** 依次应用一个 variant 的 patch：槽位整块覆盖，其他顶层键整键覆盖，后应用的 patch 胜出。 */
function applyVariantPatch(
  slots: Record<string, ProfileSlot>,
  settings: Record<string, Json>,
  document: ProfileDocument,
): void {
  if (document.kind !== "variant") {
    failProfile(`profile ${document.profileId} 不是 variant，不能作为 patch 来源`, { profileId: document.profileId });
  }
  if (document.parent !== undefined && document.parent !== null) {
    failProfile(`variant profile ${document.profileId} 不能声明 parent`, { profileId: document.profileId });
  }
  for (const key of Object.keys(document)) {
    if (!profileMetadataKeys.has(key)) {
      failProfile(`variant profile ${document.profileId} 的覆盖必须写在 patch 内`, { profileId: document.profileId, key });
    }
  }
  const patch = document.patch;
  if (patch === undefined) {
    failProfile(`variant profile ${document.profileId} 缺少 patch`, { profileId: document.profileId });
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "slots") {
      if (!isJsonObject(value)) {
        failProfile(`variant profile ${document.profileId} 的 patch.slots 必须是对象`, { profileId: document.profileId });
      }
      for (const [slot, rawSelection] of Object.entries(value)) {
        // eslint-disable-next-line security/detect-object-injection -- 键来自内容包配置的字段与槽位清单，只读合并。
        slots[slot] = normalizeSlot(document.profileId, slot, rawSelection);
      }
      continue;
    }
    if (profileMetadataKeys.has(key)) {
      failProfile(`variant profile ${document.profileId} 的 patch 不能覆盖元数据键 ${key}`, {
        profileId: document.profileId,
        key,
      });
    }
    // eslint-disable-next-line security/detect-object-injection -- 键来自内容包配置的字段与槽位清单，只读合并。
    settings[key] = value;
  }
}

/** 解析 profile 继承链并叠加 patches，输出完整槽位与顶层设置。 */
export function resolveProfile(input: ResolveProfileInput): ResolvedProfile {
  const byId = indexProfiles(input.profiles);
  const chain = resolveInheritanceChain(byId, input.profileId);
  const requested = chain[chain.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 仓库开启 noUncheckedIndexedAccess，索引访问结果可能为 undefined；Codacy 项目未开启该选项，属误报。
  if (requested === undefined) {
    failProfile(`profile ${input.profileId} 未解析出继承链`, { profileId: input.profileId });
  }
  const { slots, settings } = mergeChain(chain);
  const appliedPatchIds: string[] = [];
  for (const patchProfileId of input.patchProfileIds ?? []) {
    const document = byId.get(patchProfileId);
    if (document === undefined) {
      failProfile(`variant profile ${patchProfileId} 未定义`, { profileId: patchProfileId });
    }
    applyVariantPatch(slots, settings, document);
    appliedPatchIds.push(patchProfileId);
  }
  return {
    profileId: requested.profileId,
    kind: requested.kind,
    chain: chain.map((document) => document.profileId),
    slots,
    settings,
    appliedPatchIds,
  };
}
