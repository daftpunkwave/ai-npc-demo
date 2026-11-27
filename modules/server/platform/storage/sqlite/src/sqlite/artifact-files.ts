/**
 * 核心职责：把超过内联上限的 artifact 正文写入数据目录下的 artifacts/ 子目录，并按登记路径读取或清理。
 * 交互契约：依赖 node:fs 与 node:path；登记路径固定为 `artifacts/<artifact_id>`，相对 dataDir 解析，
 * 与 artifacts.file_path 列逐字一致。
 * 约束与禁忌：只在事务外被调用；禁止覆盖已存在的正文、接受 artifact 目录之外的路径，
 * 或让未写完的文件以最终文件名出现。
 */
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DomainError, type ArtifactFileStore } from "@world-prism/contracts";

const artifactDirectoryName = "artifacts";

/** artifact_id 只允许 ID 字符集：`.`、分隔符与空白都会被拒绝，登记路径无法借此逃出 artifact 目录。 */
const artifactIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function requireArtifactName(artifactId: string): string {
  if (!artifactIdPattern.test(artifactId)) {
    throw new DomainError("validation", "artifact ID 含有不能用作文件名的字符");
  }
  return artifactId;
}

/** dataDir/artifacts 下的 artifact 正文文件；目录在首次写入时创建，权限仅当前用户可访问。 */
export class SqliteArtifactFiles implements ArtifactFileStore {
  readonly inlineMaxBytes: number;
  private readonly directory: string;

  constructor(dataDir: string, inlineMaxBytes: number) {
    this.inlineMaxBytes = inlineMaxBytes;
    this.directory = resolve(dataDir, artifactDirectoryName);
  }

  write(artifactId: string, body: Uint8Array): string {
    const name = requireArtifactName(artifactId);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 目录由宿主注入的 dataDir 推导，不是请求入参。
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const finalPath = join(this.directory, name);
    const stagingPath = `${finalPath}.partial`;
    try {
      // 先写暂存文件再硬链接到最终名：硬链接在目标已存在时失败，既保证不覆盖既有正文，
      // 也保证进程中途退出时最终文件名只会指向完整写入的内容。
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 文件名已按 artifact ID 字符集校验。
      writeFileSync(stagingPath, body, { flag: "w", mode: 0o600 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上。
      linkSync(stagingPath, finalPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new DomainError("invalid-state", `artifact ${artifactId} 的正文文件已存在`, { cause: error });
      }
      throw error;
    } finally {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 同上。
      rmSync(stagingPath, { force: true });
    }
    return `${artifactDirectoryName}/${name}`;
  }

  read(filePath: string): Uint8Array {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路径已限定在 artifact 目录内。
    return readFileSync(this.resolveRegistered(filePath));
  }

  remove(filePath: string): void {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- 路径已限定在 artifact 目录内。
    rmSync(this.resolveRegistered(filePath), { force: true });
  }

  /** 登记路径只能是 `artifacts/<artifact_id>`；数据库中的路径同样按不可信输入校验后再解析。 */
  private resolveRegistered(filePath: string): string {
    const prefix = `${artifactDirectoryName}/`;
    if (!filePath.startsWith(prefix)) {
      throw new DomainError("invalid-state", "artifact 正文路径不在 artifact 目录内");
    }
    return join(this.directory, requireArtifactName(filePath.slice(prefix.length)));
  }
}
