/**
 * 边界检查器共享类型：公开输入输出，以及内部解析与模块元数据结构。
 * 只声明类型与字面量联合，不包含文件系统访问或规则判定逻辑。
 * 禁止在类型层维护白名单，避免规则判定散落在多个文件而难以审计。
 */
export type BoundaryRule = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ModuleKind = "service" | "contributor" | "adapter";

export type ModuleRealm = "server" | "client" | "console";

/** 一条边界违规；文件路径统一为仓库内相对路径，行号用于 CLI 定位。 */
export interface BoundaryViolation {
  readonly rule: BoundaryRule;
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** 一个 workspace 包的清单摘要；exports 只记录已声明入口名。 */
export interface BoundaryPackage {
  readonly name: string;
  readonly directory: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
}

/** 参与检查的源码文件；content 为原始文本，测试可把夹具字符串直接传入。 */
export interface BoundarySourceFile {
  readonly path: string;
  readonly content: string;
}

/** 夹具注入的模块 kind，仅在 definition 源文本读不到时使用。 */
export interface ModuleKindOverride {
  readonly packageName: string;
  readonly kind: ModuleKind;
}

/** 纯检查函数的输入：源码文件、包清单与可选的 kind 覆盖。 */
export interface BoundaryCheckInput {
  readonly files: readonly BoundarySourceFile[];
  readonly packages: readonly BoundaryPackage[];
  readonly definitionKinds?: readonly ModuleKindOverride[];
}

/** 单文件检查入口，便于测试把夹具字符串交给同一条规则链。 */
export interface SingleFileCheckInput {
  readonly path: string;
  readonly content: string;
  readonly packages?: readonly BoundaryPackage[];
  readonly definitionKinds?: readonly ModuleKindOverride[];
}

export type ImportKind = "static" | "re-export" | "dynamic" | "dynamic-non-literal";

/** 一条 import 记录；typeOnly 表示整条语句带 type 修饰，编译后不会执行目标模块。 */
export interface ImportRecord {
  readonly specifier: string;
  readonly line: number;
  readonly kind: ImportKind;
  readonly typeOnly: boolean;
}

export interface StringSpan {
  readonly start: number;
  readonly end: number;
}

export interface StrippedSource {
  readonly code: string;
  readonly stringSpans: readonly StringSpan[];
}

export interface CommentSpan {
  readonly text: string;
  readonly start: number;
}

export type HeaderLanguage = "typescript" | "sql" | "css" | "html" | "shell" | "python";

/** adapter 按所属适配器额外获得的第三方库、前缀与 Node 内置模块。 */
export interface AdapterExtras {
  readonly external: readonly string[];
  readonly externalPrefixes: readonly string[];
  readonly nodeBuiltins: readonly string[];
}

/** 一个模块包在所在 realm/kind 下允许的依赖集合。 */
export interface DependencyAllowlist {
  readonly workspace: readonly string[];
  readonly external: readonly string[];
  readonly externalPrefixes: readonly string[];
  readonly nodeBuiltins: readonly string[];
}

export interface ModulePathInfo {
  readonly realm: ModuleRealm;
  readonly identifier: string;
  readonly implementation: string;
}

export interface ModulePackageInfo {
  readonly path: ModulePathInfo;
  readonly kind: ModuleKind | null;
}

export interface CheckContext {
  readonly packagesByName: ReadonlyMap<string, BoundaryPackage>;
  readonly packagesBySpecificity: readonly BoundaryPackage[];
  readonly modulePackages: ReadonlyMap<string, ModulePackageInfo>;
}

export interface WorkspaceImportResolution {
  readonly target: BoundaryPackage | undefined;
  readonly base: string;
  readonly subpath: string | null;
}

/** 语言原生文件头的读取结果；缺失与格式错误分开报告，供规则 7 判定。 */
export type HeaderReadResult =
  | { readonly status: "ok"; readonly text: string; readonly contentStart: number }
  | { readonly status: "missing" | "invalid-format"; readonly index: number };

export interface ForbiddenCommentPattern {
  readonly code: string;
  readonly label: string;
  readonly pattern: RegExp;
}
