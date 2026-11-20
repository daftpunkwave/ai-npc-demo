/**
 * 定义端口检查使用的监听记录与 macOS lsof 输出解析。
 * 依赖 lsof 固定字段格式；不启动进程或访问网络。
 * 禁止在缺少 n 字段时把空结果当作没有监听。
 */
export interface ListenerRecord {
  readonly pid: number;
  readonly port: number;
}

export const macOSListenerArgs = [
  "-nP",
  "-iTCP",
  "-sTCP:LISTEN",
  "-F",
  "pcn",
] as const;

/** 解析 lsof 的 p/c/n 字段；n 行使用进程字段后的端口边界。 */
export function parseMacOSListeners(output: string): readonly ListenerRecord[] {
  const records: ListenerRecord[] = [];
  let pid = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid > 0) {
      const match = /:(\d+)$/.exec(line);
      if (match !== null) {
        records.push({ pid, port: Number(match[1]) });
      }
    }
  }
  return records;
}
