/**
 * 渲染控制台宿主壳、当前角色切换与模块贡献页面，不内置任何具体业务页面。
 * 依赖已启动浏览器模块、会话与 API 客户端；不绕过服务端角色校验。
 * 禁止在页面无权时隐藏失败原因，或把禁用按钮代替服务端授权。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ContributionBoundary,
  type StartedBrowserModules,
} from "@ai-npc/client-sdk";
import type { ApiClient } from "@ai-npc/client-protocol";
import type { ConsoleActiveRole, SessionDescriptor } from "@ai-npc/contracts";
import { consoleNavigation } from "./console-navigation";

interface ConsolePortWithTitle {
  readonly title: string;
}

interface ConsoleHostPort {
  setActiveRole(role: ConsoleActiveRole): void;
  readonly branchId: string;
  /** 订阅在线分支变化；返回取消订阅函数。 */
  subscribeBranch(listener: () => void): () => void;
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
  const [active, setActive] = useState<string | null>(null);
  const host = input.runtime.ports["host.console"] as ConsoleHostPort;
  // 外壳自己订阅在线分支：恢复/重开切换分支后，标题栏的分支标识与页面树都要跟着更新，
  // 不能只依赖观测页那条 WS 连接——只有 operator 权限的会话收不到 console.timeline。
  const [branchId, setBranchId] = useState(host.branchId);
  useEffect(() => {
    setBranchId(host.branchId);
    return host.subscribeBranch(() => {
      setBranchId(host.branchId);
    });
  }, [host]);
  const { pages, selected } = consoleNavigation(input.runtime.contributions, role, active);

  const switchRole = (next: ConsoleActiveRole): void => {
    host.setActiveRole(next);
    setRole(next);
    setActive(null);
  };

  return (
    <div className="console-root">
      <aside className="console-nav">
        <div className="console-brand">
          <span>GRAY HARBOR</span>
          <strong>研究控制台</strong>
          <small>{branchId}</small>
        </div>
        <nav aria-label="控制台页面">
          {pages.map(({ page, allowed }) => {
            const capability = page.extensionId.split(".").slice(0, 2).join(".");
            const port = input.runtime.ports[capability] as ConsolePortWithTitle | undefined;
            const title =
              port?.title ??
              (page.extensionId.includes("health")
                ? "运行总览"
                : page.extensionId.includes("module-admin")
                  ? "模块装配"
                  : page.extensionId.includes("model-mounts")
                    ? "模型挂载"
                    : page.extensionId.includes("faction-ops")
                      ? "势力运营"
                      : page.extensionId.includes("evaluation")
                        ? "评估与对比"
                        : page.extensionId.includes("debug")
                          ? "调试"
                          : "可观测");
            return (
              <button
                type="button"
                key={page.extensionId}
                data-testid={`console-nav-${page.extensionId.split(".")[1] ?? "page"}`}
                disabled={!allowed}
                className={page.extensionId === selected?.extensionId ? "is-active" : ""}
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
              <h1>当前角色没有可打开的页面</h1>
              <p>当前装配未包含该角色可访问的控制台页面模块。</p>
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
