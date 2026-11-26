/**
 * 渲染当前选中角色的已授权对白，并通过世界视图端口提交玩家发言。
 * 依赖玩家投影、选择端口、宿主 API 与 React 视图；不读取 Agent 私有记忆或原始 prompt。
 * 禁止展示未提交模型输出，或在命令被拒时保留乐观成功状态。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { usePort, usePortSubscription, type BrowserViewPort } from "@world-prism/client-sdk";
import type {
  ConversationLine,
  ModuleCreateInput,
  ModuleInstance,
  PlayerProjection,
} from "@world-prism/contracts";
import type { ApiClient, ProjectionState } from "@world-prism/client-protocol";

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
  refresh(): Promise<void>;
  refreshError(): string | null;
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
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const conversationRequest = useRef(0);
  const character = selectedCharacter(state?.projection, selection);
  const agentId = character?.agentId ?? null;
  const peerDialogueIds = state?.projection.conversations
    .filter((line) => line.speakerId === agentId)
    .map((line) => line.dialogueId).sort().join(",") ?? "";

  const loadConversation = useCallback(
    async (cancelled: () => boolean = () => false): Promise<void> => {
      if (agentId === null) {
        return;
      }
      const request = conversationRequest.current + 1;
      conversationRequest.current = request;
      const requestedAgent = agentId;
      try {
        const response = await api.conversation(agentId, undefined, 80);
        if (
          !cancelled() &&
          request === conversationRequest.current &&
          requestedAgent === agentId
        ) {
          setLines(response.lines);
          setConversationError(null);
        }
      } catch (error) {
        if (
          !cancelled() &&
          request === conversationRequest.current &&
          requestedAgent === agentId
        ) {
          setConversationError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [agentId, api],
  );

  useEffect(() => {
    setLines([]);
    setNotice(null);
    setConversationError(null);
    setRefreshError(null);
    return () => { conversationRequest.current += 1; };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    void loadConversation(() => cancelled);
    return () => { cancelled = true; };
  }, [loadConversation, peerDialogueIds]);

  const retryRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await worldView.refresh();
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const message = text.trim();
    if (agentId === null || message.length === 0 || sending) {
      return;
    }
    setSending(true);
    setNotice(null);
    setRefreshError(null);
    setText("");
    try {
      const accepted = await worldView.sendDialogue(agentId, message);
      if (!accepted) {
        setText(message);
        setNotice("消息未被受理");
        return;
      }
      const nextRefreshError = worldView.refreshError();
      if (nextRefreshError !== null) {
        setRefreshError(nextRefreshError);
      }
      await loadConversation();
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
        {refreshError === null ? null : (
          <p className="inline-error" role="alert">
            消息已受理，但世界投影刷新失败：{refreshError}
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void retryRefresh()}
            >
              {refreshing ? "刷新中" : "重试刷新"}
            </button>
          </p>
        )}
        {conversationError === null ? null : (
          <p className="inline-error" role="alert">
            对白读取失败：{conversationError}
            <button type="button" onClick={() => void loadConversation()}>
              重试读取
            </button>
          </p>
        )}
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
