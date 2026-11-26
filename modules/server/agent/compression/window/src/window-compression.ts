/**
 * 核心职责：按完整历史组保留最近对话，并仅在非保护段内继续裁剪到目标预算。
 * 交互契约：输入不可变 ContextArtifact，输出替代段落、来源映射与 lossReport。
 * 约束与禁忌：不得删除受保护段、工具组或改写 artifact 来源权限。
 */
import type { ContextArtifact, Json } from "@world-prism/contracts";
import type { AgentCompressionPort } from "@world-prism/module-sdk";
import type { WindowCompressionConfig } from "./definition";
import { estimateArtifactTokens, estimateTokens } from "./token-estimate";

type ContextSegment = ContextArtifact["segments"][number];

interface HistoryLine {
  readonly line: string;
  readonly speaker: string;
  readonly dialogueId: string | null;
}

function parseHistoryLine(line: string): HistoryLine {
  const body = line.replace(/^-\s*/u, "");
  const idMatch = /^\[([^\]]+)\]/u.exec(body);
  const dialogueId = idMatch?.[1] ?? null;
  const afterId = idMatch === null ? body : body.slice(idMatch[0].length).trim();
  const separator = afterId.search(/[：:]/u);
  const speaker = separator < 0 ? afterId : afterId.slice(0, separator).trim();
  return { line: `- ${body}`, speaker: speaker.length === 0 ? "unknown" : speaker, dialogueId };
}

function groupHistory(lines: readonly HistoryLine[]): readonly (readonly HistoryLine[])[] {
  const groups: HistoryLine[][] = [];
  for (const line of lines) {
    const current = groups.at(-1);
    if (current !== undefined && current[0]?.speaker === line.speaker) {
      current.push(line);
    } else {
      groups.push([line]);
    }
  }
  return groups;
}

function compressHistory(
  segments: readonly ContextSegment[],
  preserveRecentGroups: number,
): {
  readonly segments: readonly ContextSegment[];
  readonly removedGroups: number;
  readonly removedLines: number;
  readonly removedIds: readonly string[];
} {
  let removedGroups = 0;
  let removedLines = 0;
  const removedIds: string[] = [];
  const next = segments.map((segment) => {
    if (segment.kind !== "history") return segment;
    const parsed = segment.text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map(parseHistoryLine);
    const groups = groupHistory(parsed);
    if (groups.length <= preserveRecentGroups) return segment;
    const removed = groups.slice(0, groups.length - preserveRecentGroups).flat();
    removedGroups += groups.length - preserveRecentGroups;
    removedLines += removed.length;
    for (const line of removed) {
      if (line.dialogueId !== null) removedIds.push(line.dialogueId);
    }
    const retained = preserveRecentGroups === 0 ? [] : groups.slice(-preserveRecentGroups).flat();
    const notice = `（更早的 ${removed.length} 条对话已省略）`;
    const text = [notice, ...retained.map((line) => line.line)].join("\n");
    return { ...segment, text, tokenEstimate: estimateTokens(text) };
  });
  return { segments: next, removedGroups, removedLines, removedIds };
}

function trimUnprotectedSegments(
  segments: readonly ContextSegment[],
  system: string,
  targetTokens: number,
): { readonly segments: readonly ContextSegment[]; readonly removedLines: Record<string, number> } {
  const next = segments.map((segment) => ({ ...segment }));
  const removedLines: Record<string, number> = {};
  const trimOrder = ["memory", "world", "task"] as const;
  for (const kind of trimOrder) {
    for (const segment of next) {
      if (segment.kind !== kind || segment.protected) continue;
      const lines = segment.text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
      while (lines.length > 0) {
        const currentTokens = estimateArtifactTokens(
          system,
          next.filter((item) => item.role === "user").map((item) => item.text),
        );
        if (currentTokens <= targetTokens) return { segments: next, removedLines };
        lines.pop();
        removedLines[kind] = (removedLines[kind] ?? 0) + 1;
        segment.text = lines.join("\n");
        segment.tokenEstimate = estimateTokens(segment.text);
      }
    }
  }
  return { segments: next, removedLines };
}

export function compressWindow(
  artifact: ContextArtifact,
  effectiveMaxTokens: number,
  requestedTargetTokens: number,
  config: WindowCompressionConfig,
): ReturnType<AgentCompressionPort["compress"]> {
  const configuredTriggerTokens = config.triggerRatio * effectiveMaxTokens;
  const targetTokens = Math.max(1, Math.min(requestedTargetTokens, config.targetTokenRatio * effectiveMaxTokens));
  const triggerTokens = Math.min(configuredTriggerTokens, targetTokens);
  if (artifact.tokenEstimate <= triggerTokens) {
    return {
      status: "not-triggered",
      system: artifact.system,
      segments: artifact.segments,
      lossReport: {
        policy: "window",
        effectiveMaxTokens,
        triggerTokens,
        configuredTriggerTokens,
        inputTokens: artifact.tokenEstimate,
        outputTokens: artifact.tokenEstimate,
        targetTokens,
      } satisfies Json,
    };
  }

  const history = compressHistory(artifact.segments, config.preserveRecentGroups);
  const trimmed = trimUnprotectedSegments(history.segments, artifact.system, targetTokens);
  const outputTokens = estimateArtifactTokens(
    artifact.system,
    trimmed.segments.filter((segment) => segment.role === "user").map((segment) => segment.text),
  );
  const changed = history.removedLines > 0 ||
    Object.values(trimmed.removedLines).some((count) => count > 0) ||
    outputTokens < artifact.tokenEstimate;
  return {
    status: outputTokens <= targetTokens ? "compressed" : "cannot-fit",
    system: artifact.system,
    segments: trimmed.segments.map((segment) => ({ ...segment })),
    lossReport: {
      policy: "window",
      effectiveMaxTokens,
      triggerTokens,
      configuredTriggerTokens,
      targetTokens,
      inputTokens: artifact.tokenEstimate,
      outputTokens,
      changed,
      removed: {
        historyGroups: history.removedGroups,
        linesByKind: trimmed.removedLines,
      },
      sourceMap: { removedDialogueIds: [...history.removedIds] },
    } satisfies Json,
  };
}