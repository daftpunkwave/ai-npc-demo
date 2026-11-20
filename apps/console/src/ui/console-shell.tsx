/**
 * 渲染控制台宿主壳、当前角色切换与模块贡献页面，不内置任何具体业务页面。
 * 依赖已启动浏览器模块、会话与 API 客户端；不绕过服务端角色校验。
 * 禁止在页面无权时隐藏失败原因，或把禁用按钮代替服务端授权。
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  ContributionBoundary,
  type StartedBrowserModules,
} from "@ai-npc/client-sdk";
import type { ApiClient } from "@ai-npc/client-protocol";
import type { ConsoleActiveRole, SessionDescriptor } from "@ai-npc/contracts";

interface ConsolePortWithTitle {
  readonly title: string;
}

interface ConsoleHostPort {
  setActiveRole(role: ConsoleActiveRole): void;
}

const roleLabels: Readonly<Record<ConsoleActiveRole, string>> = {
  operator: "运营者",
  researcher: "研究员",
  evaluator: "评估者",
};

export function ConsoleShell(input: {
  readonly api: ApiClient;
  readonly session: SessionDescriptor;
  readonly runtime: StartedBrowserModules;
  readonly initialRole: ConsoleActiveRole;
}): ReactNode {
  const roles = input.session.roles.filter(
    (role): role is ConsoleActiveRole =>
      role === "operator" || role === "researcher" || role === "evaluator",
  );
  const [role, setRole] = useState<ConsoleActiveRole>(input.initialRole);
  const pages = input.runtime.contributions.filter((item) => item.slot === "console.page");
  const firstAllowed = pages.find((page) => page.allowedRoles?.includes(role));
  const [active, setActive] = useState<string | null>(firstAllowed?.extensionId ?? null);
  const selected = useMemo(
    () => pages.find((page) => page.extensionId === active && page.allowedRoles?.includes(role)) ?? null,
    [active, pages, role],
  );

  const switchRole = (next: ConsoleActiveRole): void => {
    const host = input.runtime.ports["host.console"] as ConsoleHostPort;
    host.setActiveRole(next);
    setRole(next);
    const nextAllowed = pages.find((page) => page.allowedRoles?.includes(next));
    setActive(nextAllowed?.extensionId ?? null);
  };

  return (
    <div className="console-root">
      <aside className="console-nav">
        <div className="console-brand">
          <span>GRAY HARBOR</span>
          <strong>研究控制台</strong>
          <small>{input.session.branchId}</small>
        </div>
        <nav aria-label="控制台页面">
          {pages.map((page) => {
            const allowed = page.allowedRoles?.includes(role) ?? false;
            const capability = page.extensionId.split(".").slice(0, 2).join(".");
            const port = input.runtime.ports[capability] as ConsolePortWithTitle | undefined;
            const title =
              port?.title ??
              (page.extensionId.includes("health")
                ? "运行总览"
                : page.extensionId.includes("module-admin")
                  ? "模块装配"
                  : "可观测");
            return (
              <button
                type="button"
                key={page.extensionId}
                data-testid={`console-nav-${page.extensionId.split(".")[1] ?? "page"}`}
                disabled={!allowed}
                className={page.extensionId === active ? "is-active" : ""}
                title={allowed ? title : `${title}：当前角色无权访问`}
                onClick={() => setActive(page.extensionId)}
              >
                <span>{title}</span>
                <small>{allowed ? "打开" : "无权限"}</small>
              </button>
            );
          })}
        </nav>
        <footer>
          <span>127.0.0.1:3000</span>
          <span>同源 API / WS</span>
        </footer>
      </aside>
      <main className="console-main">
        <header className="console-topbar">
          <div>
            <span>当前会话</span>
            <strong>{input.session.principalId}</strong>
          </div>
          <label>
            <span>当前角色</span>
            <select
              data-testid="console-role"
              value={role}
              onChange={(event) => switchRole(event.target.value as ConsoleActiveRole)}
            >
              {roles.map((item) => (
                <option key={item} value={item}>{roleLabels[item]}</option>
              ))}
            </select>
          </label>
        </header>
        <div className="console-content">
          {selected === null ? (
            <section className="console-denied" data-testid="console-role-denied">
              <span className="console-eyebrow">角色边界</span>
              <h1>当前角色没有可打开的首批页面</h1>
              <p>评估者只能读取 run 与报告；对应页面将在评估工作流接入后装配。</p>
            </section>
          ) : (
            <ContributionBoundary extensionId={selected.extensionId}>
              {selected.render()}
            </ContributionBoundary>
          )}
        </div>
      </main>
    </div>
  );
}
