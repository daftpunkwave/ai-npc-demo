/**
 * 核心职责：定义资产校验的公开报告与选项类型。
 * 交互契约：违规集合贯穿全部校验阶段，报告由主检查器汇总、CLI 据违规数量决定退出码。
 * 约束与禁忌：禁止在这里携带实现逻辑或文件访问。
 */
export interface AssetViolation {
  readonly code: string;
  readonly message: string;
}

export interface AssetCheckReport {
  readonly assetCount: number;
  readonly nodeCount: number;
  readonly factionCount: number;
  readonly violations: readonly AssetViolation[];
}

export interface AssetCheckOptions {
  readonly root?: string;
}

export interface AssetCliOptions extends AssetCheckOptions {
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}
