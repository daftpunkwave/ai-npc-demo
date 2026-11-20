/**
 * 管理开发与生产双端脚本的子进程生命周期，并把同一环境传给服务端、客户端与控制台构建。
 * 依赖 Node 子进程与环境文件加载；不监听端口、不实现业务逻辑。
 * 禁止换用其他端口、遗留子进程或在任一进程退出后继续假装运行。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const tsxCli = resolve(projectRoot, "node_modules/tsx/dist/cli.mjs");
const viteCli = resolve(projectRoot, "node_modules/vite/bin/vite.js");

export type SystemCommandName =
  | "cmd"
  | "powershell"
  | "taskkill"
  | "ps"
  | "ss"
  | "lsof";

function windowsRoot(): string {
  return process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
}

const systemCommandCandidates: Readonly<
  Record<SystemCommandName, () => readonly string[]>
> = {
  cmd: () => [resolve(windowsRoot(), "System32", "cmd.exe")],
  powershell: () => [
    resolve(windowsRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ],
  taskkill: () => [resolve(windowsRoot(), "System32", "taskkill.exe")],
  ps: () => ["/bin/ps", "/usr/bin/ps"],
  ss: () => ["/usr/bin/ss", "/sbin/ss"],
  lsof: () => ["/usr/sbin/lsof", "/usr/bin/lsof"],
};

const systemCommands = new Map<SystemCommandName, string>();

/** 只从固定的系统目录解析工程脚本依赖的命令，避免受 PATH 搜索顺序影响。 */
export function systemCommandPath(command: SystemCommandName): string {
  const cached = systemCommands.get(command);
  if (cached !== undefined) {
    return cached;
  }
  const executable = systemCommandCandidates[command]().find((path) => existsSync(path));
  if (executable === undefined) {
    throw new Error(`找不到系统命令 ${command} 的固定可执行文件`);
  }
  systemCommands.set(command, executable);
  return executable;
}

export function loadProjectEnvironment(): void {
  const envFile = resolve(projectRoot, ".env");
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

export interface ManagedProcess {
  readonly label: string;
  readonly child: ChildProcess;
}

function spawnManaged(label: string, args: readonly string[]): ManagedProcess {
  const child = spawn(node, [...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error("[ai-npc] 子进程启动失败", { label, error });
  });
  return { label, child };
}

export function serverProcess(): ManagedProcess {
  return spawnManaged("server", [tsxCli, "apps/server/src/main.ts"]);
}

export function clientDevProcess(): ManagedProcess {
  return spawnManaged("client", [viteCli, "apps/client", "--config", "apps/client/vite.config.ts"]);
}

export function clientPreviewProcess(): ManagedProcess {
  return spawnManaged("client-preview", [
    viteCli,
    "preview",
    "apps/client",
    "--config",
    "apps/client/vite.config.ts",
  ]);
}

export function consoleWatchProcess(): ManagedProcess {
  return spawnManaged("console-watch", [
    viteCli,
    "build",
    "apps/console",
    "--config",
    "apps/console/vite.config.ts",
    "--watch",
  ]);
}

/** 结束本脚本创建的子进程；Windows 同时结束其子进程树。 */
export function terminateProcess(entry: ManagedProcess): void {
  const pid = entry.child.pid;
  if (pid === undefined || entry.child.exitCode !== null) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawn(systemCommandPath("taskkill"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      entry.child.kill("SIGTERM");
    }
  } catch {
    // 进程已退出或句柄已回收时无需再次操作。
  }
}

/** 等待任意子进程退出，然后结束其余子进程并返回首个退出码。 */
export async function supervise(processes: readonly ManagedProcess[]): Promise<number> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const entry of processes) {
        terminateProcess(entry);
      }
      resolveExit(code ?? 1);
    };
    const stop = (): void => finish(130);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    for (const entry of processes) {
      entry.child.once("exit", (code, signal) => {
        if (!settled) {
          console.info(`[ai-npc] ${entry.label} 已退出：${signal ?? code ?? "unknown"}`);
        }
        finish(code);
      });
    }
  });
}
