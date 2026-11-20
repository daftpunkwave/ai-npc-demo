/**
 * 渲染当前选中角色的已授权对白，并通过世界视图端口提交玩家发言。
 * 依赖玩家投影、选择端口、宿主 API 与 React 视图；不读取 Agent 私有记忆或原始 prompt。
 * 禁止展示未提交模型输出，或在命令被拒时保留乐观成功状态。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { usePort, usePortSubscription, type BrowserViewPort } from "@ai-npc/client-sdk";
import type {
  ConversationLine,
  ModuleCreateInput,
  ModuleInstance,
  PlayerProjection,
} from "@ai-npc/contracts";
import type { ApiClient, ProjectionState } from "@ai-npc/client-protocol";

interface Selection {
  readonly kind: "node" | "character" | "team" | "task";
  readonly id: string;
}

interface SelectionLike {
  subscribe(listener: (selection: Selection | null) => void): () => void;
  getSnapshot(): Selection | null;
  select(selection: Selection | null): void;
}

interface WorldViewLike {
  subscribe(listener: (state: ProjectionState | null) => void): () => void;
  getSnapshot(): ProjectionState | null;
  sendDialogue(agentId: string, text: string): Promise<boolean>;
}

function selectedCharacter(
  projection: PlayerProjection | undefined,
  selection: Selection | null,
): PlayerProjection["characters"][number] | undefined {
  if (selection?.kind !== "character") {
    return undefined;
  }
  return projection?.characters.find((character) => character.agentId === selection.id);
}

function DialogueView(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const selectionPort = usePort<SelectionLike>("client.input");
  const api = usePort<ApiClient>("host.api");
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  const selection = usePortSubscription<Selection | null>("client.input");
  const [text, setText] = useState("");
  const [lines, setLines] = useState<readonly ConversationLine[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const character = selectedCharacter(state?.projection, selection);
  const agentId = character?.agentId ?? null;

  useEffect(() => {
    setLines([]);
    setNotice(null);
    if (agentId === null) {
      return;
    }
    let cancelled = false;
    void api
      .conversation(agentId, undefined, 80)
      .then((response) => {
        if (!cancelled) {
          setLines(response.lines);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLines([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, agentId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = text.trim();
    if (agentId === null || message.length === 0 || sending) {
      return;
    }
    setSending(true);
    setNotice(null);
    setText("");
    try {
      const accepted = await worldView.sendDialogue(agentId, message);
      if (!accepted) {
        setText(message);
        setNotice("消息未被受理");
        return;
      }
      const response = await api.conversation(agentId, undefined, 80).catch(() => null);
      if (response !== null) {
        setLines(response.lines);
      } else {
        setLines((current) => [
          ...current,
          {
            seq: current.length,
            dialogueId: "dlg-abcdefghjkmn" as ConversationLine["dialogueId"],
            speakerId: "player-1",
            speakerName: "党魁",
            text: message,
            worldTick: state?.projection.clock.worldTick ?? 0,
            channel: "face-to-face",
          },
        ]);
      }
    } catch (error) {
      setText(message);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (character === undefined) {
    return (
      <section className="dialogue dialogue-idle">
        <span className="dialogue-rule" />
        <p>从人物或场景中选择一名角色开始交谈。</p>
      </section>
    );
  }
  return (
    <section className="dialogue" aria-label={`与${character.name}的对话`}>
      <header className="dialogue-head">
        <div>
          <span className="eyebrow">当前会话</span>
          <strong>{character.name}</strong>
          <small>{character.role}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭对话"
          onClick={() => selectionPort.select(null)}
        >
          ×
        </button>
      </header>
      <div className="dialogue-lines" aria-live="polite">
        {lines.length === 0 ? (
          <p className="dialogue-empty">尚未留下已提交的对话。第一句话会先成为世界事件，再等待对方处理。</p>
        ) : (
          lines.map((line) => (
            <article
              className={`dialogue-line ${line.speakerId === "player-1" ? "is-player" : ""}`}
              data-testid="dialogue-line"
              key={`${line.dialogueId}-${line.seq}`}
            >
              <span>{line.speakerName}</span>
              <p>{line.text}</p>
              <time>t{line.worldTick}</time>
            </article>
          ))
        )}
        {notice === null ? null : <p className="inline-error" role="alert">{notice}</p>}
      </div>
      <form className="dialogue-compose" onSubmit={(event) => void submit(event)}>
        <input
          data-testid="dialogue-input"
          value={text}
          maxLength={300}
          placeholder={`对${character.name}说……`}
          onChange={(event) =>
            setText((event.currentTarget as unknown as { value: string }).value)
          }
        />
        <button
          type="submit"
          data-testid="dialogue-send"
          disabled={sending || text.trim().length === 0}
        >
          {sending ? "提交中" : "提交发言"}
        </button>
      </form>
    </section>
  );
}

export function createDialogueModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <DialogueView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
