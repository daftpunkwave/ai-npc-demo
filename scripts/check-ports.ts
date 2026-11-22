/**
 * 启动开发或生产双端，枚举本次进程树实际监听的端口，并验证只存在 5173 与 3000。
 * 依赖 Node 子进程、网络探针与操作系统进程/监听查询；不修改应用装配。
 * 禁止把机器上的无关监听算作通过，也禁止在失败后遗留本次启动的进程。
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { projectRoot, systemCommandPath } from "./processes";
import {
  macOSListenerArgs,
  parseMacOSListeners,
  type ListenerRecord,
} from "./port-listeners";

const expectedPorts = [3000, 5173] as const;
// 项目只允许本机 HTTP，这两个地址不会承载远端或凭据流量。
const healthUrl = "http://127.0.0.1:3000/api/v1/health";
const clientUrl = "http://127.0.0.1:5173/";

interface ProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
}

interface ProcessSnapshot {
  readonly processes: readonly ProcessRecord[];
  readonly listeners: readonly ListenerRecord[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function descendantsOf(rootPid: number, processes: readonly ProcessRecord[]): ReadonlySet<number> {
  const result = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processRecord of processes) {
      if (result.has(processRecord.parentPid) && !result.has(processRecord.pid)) {
        result.add(processRecord.pid);
        changed = true;
      }
    }
  }
  return result;
}

function windowsSnapshot(rootPid: number): ProcessSnapshot {
  const script = [
    "$processes = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
    "$listeners = Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess",
    "[pscustomobject]@{ processes = $processes; listeners = $listeners } | ConvertTo-Json -Depth 5 -Compress",
  ].join("; ");
  const output = execFileSync(
    systemCommandPath("powershell"),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  const parsed = JSON.parse(output) as {
    readonly processes?: readonly { readonly ProcessId?: number; readonly ParentProcessId?: number }[];
    readonly listeners?: readonly { readonly LocalPort?: number; readonly OwningProcess?: number }[];
  };
  const processes = parsed.processes ?? [];
  const listeners = parsed.listeners ?? [];
  const processTree = descendantsOf(
    rootPid,
    processes.map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
    })),
  );
  return {
    processes: [...processTree].map((pid) => ({ pid, parentPid: 0 })),
    listeners: listeners
      .map((item) => ({
        pid: Number(item.OwningProcess),
        port: Number(item.LocalPort),
      }))
      .filter((item) => processTree.has(item.pid)),
  };
}

function unixProcesses(): readonly ProcessRecord[] {
  const output = execFileSync(systemCommandPath("ps"), ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    windowsHide: true,
  });
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((parts) => parts.length >= 2 && Number.isInteger(parts[0]) && Number.isInteger(parts[1]))
    .map((parts) => ({ pid: parts[0] as number, parentPid: parts[1] as number }));
}

function linuxListeners(): readonly ListenerRecord[] {
  const output = execFileSync(systemCommandPath("ss"), ["-ltnp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const records: ListenerRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const portMatch = /:(\d+)\s+/.exec(line);
    const pidMatches = [...line.matchAll(/pid=(\d+)/g)];
    if (portMatch === null) {
      continue;
    }
    for (const match of pidMatches) {
      records.push({ port: Number(portMatch[1]), pid: Number(match[1]) });
    }
  }
  return records;
}

function macOSListeners(): readonly ListenerRecord[] {
  const output = execFileSync(systemCommandPath("lsof"), macOSListenerArgs, {
    encoding: "utf8",
    windowsHide: true,
  });
  return parseMacOSListeners(output);
}

function snapshot(rootPid: number): ProcessSnapshot {
  if (process.platform === "win32") {
    return windowsSnapshot(rootPid);
  }
  const processes = unixProcesses();
  const tree = descendantsOf(rootPid, processes);
  const listeners = process.platform === "darwin" ? macOSListeners() : linuxListeners();
  return {
    processes: [...tree].map((pid) => ({ pid, parentPid: 0 })),
    listeners: listeners.filter((item) => tree.has(item.pid)),
  };
}

function childEnvironment(): NodeJS.ProcessEnv {
  const dataDir = resolve(projectRoot, "data/port-check");
  rmSync(dataDir, { recursive: true, force: true });
  return {
    ...process.env,
    NPC_SERVER_HOST: "127.0.0.1",
    NPC_SERVER_PORT: "3000",
    NPC_CLIENT_PORT: "5173",
    NPC_DATA_DIR: dataDir,
    NPC_ASSEMBLY: "local-slg-test-v1",
    NPC_MODEL_LAYOUT: "deterministic-model-layout-v1",
    NPC_ROSTER: "core-3",
    NPC_PLAYER_TOKEN: "ports-player",
    NPC_CONSOLE_TOKEN: "ports-console",
    NPC_OPERATOR_TOKEN: "ports-operator",
    NPC_RESEARCHER_TOKEN: "ports-researcher",
    NPC_EVALUATOR_TOKEN: "ports-evaluator",
  };
}

function spawnPnpm(args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  const command = process.platform === "win32"
    ? systemCommandPath("cmd")
    : "pnpm";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`]
    : [...args];
  return spawn(command, commandArgs, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawn(systemCommandPath("taskkill"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastError = "未收到响应";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`启动进程提前退出，退出码 ${child.exitCode}`);
    }
    try {
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const health = await fetch(healthUrl);
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
      const client = await fetch(clientUrl);
      if (health.ok && client.ok) {
        return;
      }
      lastError = `health=${health.status}, client=${client.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`等待双端就绪超时：${lastError}`);
}

async function assertPortsFree(): Promise<void> {
  for (const port of expectedPorts) {
    await new Promise<void>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => (error === undefined ? resolvePort() : reject(error)));
      });
    }).catch((error: unknown) => {
      throw new Error(`端口 ${port} 已被占用，端口检查不能开始：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function verifyMode(mode: "dev" | "start", env: NodeJS.ProcessEnv): Promise<void> {
  await assertPortsFree();
  const child = spawnPnpm([mode], env);
  try {
    await waitForReady(child);
    await sleep(1_000);
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`${mode} 没有子进程 PID`);
    }
    const ports = [...new Set(snapshot(pid).listeners.map((item) => item.port))].sort((a, b) => a - b);
    const expected = [...expectedPorts].sort((a, b) => a - b);
    if (ports.length !== expected.length || ports.some((port, index) => port !== expected[index])) {
      throw new Error(`pnpm ${mode} 的监听端口为 [${ports.join(", ")}]，期望 [${expected.join(", ")}]`);
    }
    process.stdout.write(`[ports] pnpm ${mode}: ${ports.join(", ")}\n`);
  } finally {
    killTree(child);
    await sleep(500);
  }
}

async function verifyOccupiedPortFailure(env: NodeJS.ProcessEnv): Promise<void> {
  await assertPortsFree();
  const blocker = createServer();
  await new Promise<void>((resolveListen, reject) => {
    blocker.once("error", reject);
    blocker.listen(3000, "127.0.0.1", resolveListen);
  });
  const child = spawnPnpm(["start"], env);
  try {
    const code = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => {
        killTree(child);
        resolveExit(null);
      }, 25_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolveExit(exitCode);
      });
    });
    if (code === null) {
      throw new Error("3000 被占用时启动进程未在超时内失败");
    }
    if (code === 0) {
      throw new Error("3000 被占用时启动进程错误地返回成功");
    }
    process.stdout.write("[ports] 占用 3000 时启动按预期失败\n");
  } finally {
    killTree(child);
    await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
  }
}

async function main(): Promise<void> {
  const env = childEnvironment();
  process.stdout.write("[ports] 构建浏览器产物\n");
  const build = spawnPnpm(["build"], env);
  const buildCode = await new Promise<number | null>((resolveBuild) => {
    build.once("exit", resolveBuild);
  });
  if (buildCode !== 0) {
    throw new Error(`构建失败，退出码 ${String(buildCode)}`);
  }
  await verifyMode("dev", env);
  await verifyMode("start", env);
  await verifyOccupiedPortFailure(env);
  process.stdout.write("[ports] 双端监听与占用失败行为通过\n");
}

main().catch((error: unknown) => {
  console.error(`[ports] 检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
