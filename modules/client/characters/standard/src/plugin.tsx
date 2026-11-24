/**
 * 以可点击 DOM 列表呈现玩家当前可见的人物、地点、任务、协议与笔记。
 * 依赖授权投影、客户端内容视图与选择端口；人物点击只打开会话，不产生世界命令。
 * 禁止用侧栏列表补造投影中不存在的地点、参数或协议。
 */
import { useMemo, useState, type ReactNode } from "react";
import { usePort, usePortSubscription, type BrowserViewPort } from "@ai-npc/client-sdk";
import type { ClientContentView, ModuleCreateInput, ModuleInstance, PlayerProjection } from "@ai-npc/contracts";
import type { ProjectionState } from "@ai-npc/client-protocol";
import { groupByNodeId } from "./node-index";

type Tab = "characters" | "places" | "tasks" | "agreements" | "notebook";

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
  getCampaign(): unknown;
  getContent(): ClientContentView | null;
}

const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "characters", label: "人物" },
  { id: "places", label: "地点" },
  { id: "tasks", label: "任务" },
  { id: "agreements", label: "协议" },
  { id: "notebook", label: "笔记" },
];

function Empty({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="sidebar-empty">{children}</p>;
}

function charactersTab(
  projection: PlayerProjection,
  selection: Selection | null,
  select: SelectionLike,
): ReactNode {
  return (
    <div className="character-list">
      {projection.characters.map((character) => (
        <button
          type="button"
          className={`character-row ${selection?.kind === "character" && selection.id === character.agentId ? "is-selected" : ""}`}
          data-testid={`list-character-${character.agentId}`}
          key={character.agentId}
          onClick={() => select.select({ kind: "character", id: character.agentId })}
        >
          <span className={`character-dot faction-${character.factionId}`} />
          <span className="character-copy">
            <strong>{character.name}</strong>
            <small>{character.role}</small>
            <em>{character.publicClaim ?? "立场尚未公开"}</em>
          </span>
          <span className={character.injured ? "status-injured" : "status-ok"}>
            {character.injured ? "负伤" : "在场"}
          </span>
        </button>
      ))}
    </div>
  );
}

function placesTab(
  projection: PlayerProjection,
  selection: Selection | null,
  select: SelectionLike,
): ReactNode {
  // 先按节点分组一次，把逐节点重扫全量库存与角色的平方级扫描降回线性。
  const stockpilesByNode = groupByNodeId(projection.stockpiles);
  const peopleByNode = groupByNodeId(projection.characters);
  return (
    <div className="place-list">
      {projection.map.nodes.map((node) => {
        const stockpiles = stockpilesByNode.get(node.nodeId) ?? [];
        const people = peopleByNode.get(node.nodeId) ?? [];
        return (
          <button
            type="button"
            key={node.nodeId}
            data-testid={`list-node-${node.nodeId}`}
            className={selection?.kind === "node" && selection.id === node.nodeId ? "place-row is-selected" : "place-row"}
            onClick={() => select.select({ kind: "node", id: node.nodeId })}
          >
            <span>
              <strong>{node.name}</strong>
              <small>{node.facilities.join(" · ") || "开放地点"}</small>
            </span>
            <span>
              <b>{people.length}</b> 人在场
            </span>
            {stockpiles.map((stockpile) => (
              <em key={stockpile.stockpileId}>
                供给 {stockpile.supplyLevel} / 能源 {stockpile.energyLevel} / 医疗 {stockpile.medicalLevel}
              </em>
            ))}
          </button>
        );
      })}
    </div>
  );
}

function tasksTab(projection: PlayerProjection): ReactNode {
  if (projection.tasks.length === 0) {
    return <Empty>当前没有已提交任务。所有派遣都仍需经过命令网关和规则校验。</Empty>;
  }
  return (
    <div className="record-list">
      {projection.tasks.map((task, index) => (
        <article className="record-row" data-testid={task.taskId === null ? undefined : `task-row-${task.taskId}`} key={task.taskId ?? `other-${index}`}>
          <strong>{task.taskType ?? "其他队伍任务"}</strong>
          <span>{task.commandStatus ?? "不公开"} / {task.taskStatus ?? "在途"}</span>
          <small>
            {task.departTick === null ? "尚未出发" : `t${task.departTick} 出发`}
            {task.nominalCompletionTick === null ? "" : ` · 预计 t${task.nominalCompletionTick}`}
          </small>
        </article>
      ))}
    </div>
  );
}

function agreementsTab(projection: PlayerProjection): ReactNode {
  if (projection.agreements.length === 0) {
    return <Empty>尚无可查看协议。</Empty>;
  }
  return (
    <div className="record-list">
      {projection.agreements.map((agreement) => (
        <article className="record-row" key={agreement.agreementId}>
          <strong>{agreement.status}</strong>
          <span>{agreement.parties.join(" / ")}</span>
          <small>{agreement.terms.map((term) => `${term.term.kind}: ${term.status}`).join(" · ")}</small>
        </article>
      ))}
    </div>
  );
}

function notebookTab(projection: PlayerProjection): ReactNode {
  if (projection.notebook.length === 0) {
    return <Empty>尚无获准写入笔记的证据或亲历记录。</Empty>;
  }
  return (
    <div className="record-list">
      {projection.notebook.map((entry, index) => (
        <article className="record-row" key={`${entry.kind}-${index}`}>
          <strong>{entry.kind === "evidence" ? entry.title : "亲历记录"}</strong>
          <p>{entry.kind === "evidence" ? entry.body : entry.summaryZh}</p>
          <small>{entry.kind === "evidence" ? entry.source : `t${entry.worldTick}`}</small>
        </article>
      ))}
    </div>
  );
}

function CharactersView(): ReactNode {
  const worldView = usePort<WorldViewLike>("client.world-view");
  const selectionPort = usePort<SelectionLike>("client.input");
  const state = usePortSubscription<ProjectionState | null>("client.world-view");
  const selection = usePortSubscription<Selection | null>("client.input");
  const [tab, setTab] = useState<Tab>("characters");
  const projection = state?.projection;
  const content = worldView.getContent();
  const activeCount = useMemo(
    () => projection?.characters.filter((character) => !character.injured).length ?? 0,
    [projection],
  );
  if (
    content === null ||
    projection === undefined ||
    projection.campaign === null ||
    worldView.getCampaign() === null
  ) {
    return null;
  }
  return (
    <aside className="sidebar-panel">
      <header className="sidebar-head">
        <div>
          <span className="eyebrow">{content.ui.siteLabel}</span>
          <strong>可行动信息</strong>
        </div>
        <span className="sidebar-count">{activeCount} 人可接触</span>
      </header>
      <nav className="sidebar-tabs" aria-label="侧栏分类">
        {tabs.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={tab === entry.id ? "is-active" : ""}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-body">
        {tab === "characters" ? charactersTab(projection, selection, selectionPort) : null}
        {tab === "places" ? placesTab(projection, selection, selectionPort) : null}
        {tab === "tasks" ? tasksTab(projection) : null}
        {tab === "agreements" ? agreementsTab(projection) : null}
        {tab === "notebook" ? notebookTab(projection) : null}
      </div>
      <footer className="sidebar-foot">
        <span>投影 t{projection.clock.worldTick}</span>
        <span>{projection.clock.mode === "running" ? "实时同步" : "时钟暂停"}</span>
      </footer>
    </aside>
  );
}

export function createCharactersModule(input: ModuleCreateInput): Promise<ModuleInstance> {
  const port: BrowserViewPort = { renderContribution: () => <CharactersView /> };
  return Promise.resolve({
    moduleId: input.moduleId,
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    port,
  });
}
