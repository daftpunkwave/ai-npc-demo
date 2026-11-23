/**
 * 核心职责：定义实验规格的严格 schema 与展开规则：RunSpec 模板、脚本章节、变体与重复次数。
 * 交互契约：只做结构校验与确定性的 run 展开计算；引用存在性、profile 可解析性与内容交叉检查
 * 由加载器与宿主预检负责。
 * 约束与禁忌：禁止在此读取文件、生成随机 seed 或在展开时省略任何变体或脚本分支。
 */
import { z } from "zod";
import { configRefSchema, runSpecSchema } from "./schema";

/**
 * RunSpec 模板：与 RunSpec 同形状，但去掉 id、variant 与 script 三个由实验决定的字段，
 * 以及只属于完整 RunSpec 文档的 schemaVersion（实验规格自身在顶层声明版本）。
 */
export const experimentRunSpecTemplateSchema = runSpecSchema
  .omit({ schemaVersion: true, id: true, variant: true, script: true })
  .strict();

export type ExperimentRunSpecTemplate = z.infer<typeof experimentRunSpecTemplateSchema>;

/**
 * 实验规格：一份 RunSpec 模板加变体、脚本分支与重复次数。
 * `variants` 的顺序即 run 的创建顺序；`runOrder: rotate` 时按重复序号轮转变体起点，
 * 避免同一变体总是先跑而受队列预热影响。
 * `scriptBranches` 为空表示脚本没有命名分支，每个变体只跑一次。
 */
export const experimentSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: configRefSchema,
    base: experimentRunSpecTemplateSchema,
    scriptRef: configRefSchema,
    scriptBranches: z.array(configRefSchema),
    /** 每个 run 都先应用的补丁，按顺序叠加在变体补丁之前。 */
    commonPatchRefs: z.array(configRefSchema),
    variants: z.array(configRefSchema).min(1),
    repetitions: z.number().int().positive(),
    runOrder: z.enum(["sequential", "rotate"]),
  })
  .strict();

export type ExperimentSpec = z.infer<typeof experimentSpecSchema>;

/** 展开后的单个 run：变体、脚本分支、重复序号与派生 seed。 */
export interface ExpandedRun {
  readonly variantRef: string;
  /** 脚本分支名；脚本没有命名分支时为 null，调用方据此省略 RunSpec 的 `script.branch`。 */
  readonly scriptBranch: string | null;
  readonly repetition: number;
  readonly seed: string;
  /** 实际应用的 profile patch 列表；变体补丁总在最后。 */
  readonly profilePatchRefs: readonly string[];
  readonly variantId: string;
}

/**
 * 按「变体 × 脚本分支 × 重复次数」展开 run，顺序确定：
 * 同一个重复序号内，变体按 `runOrder` 排列；重复序号外层递增。
 *
 * seed 为 `base.seed + ":rep" + 重复序号`，因此同一次重复的各变体共享 seed，
 * 便于配对比较；不同重复之间有独立随机流。
 *
 * `scriptBranches` 为空时 `scriptBranch` 为 `null`：脚本没有命名分支，
 * 不伪造任何分支名，因为真实脚本完全可能把一个分支命名为任意合法标识符。
 */
export function expandExperimentRuns(spec: ExperimentSpec): readonly ExpandedRun[] {
  const branches: readonly (string | null)[] = spec.scriptBranches.length === 0 ? [null] : spec.scriptBranches;
  const runs: ExpandedRun[] = [];
  for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
    const variants = spec.runOrder === "rotate"
      ? rotate(spec.variants, repetition - 1)
      : spec.variants;
    for (const variantRef of variants) {
      for (const scriptBranch of branches) {
        runs.push({
          variantRef,
          scriptBranch,
          repetition,
          seed: `${spec.base.seed}:rep${repetition}`,
          profilePatchRefs: [...spec.commonPatchRefs, variantRef],
          variantId: variantRef,
        });
      }
    }
  }
  return runs;
}

/** 把数组左移 offset 位；offset 归一化到数组长度内，空数组原样返回。 */
function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  if (values.length === 0) {
    return values;
  }
  const shift = offset % values.length;
  return [...values.slice(shift), ...values.slice(0, shift)];
}
