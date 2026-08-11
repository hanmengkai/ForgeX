import type { RequirementListItem, WorkerFleetOverview } from "./api.js";
import type { MouseEvent } from "react";
import {
  AgentIcon,
  ApprovalIcon,
  CheckIcon,
  PulseIcon,
  RequirementIcon,
} from "./icons.js";

interface DashboardOverviewProps {
  projectName: string;
  items: RequirementListItem[];
  workers: WorkerFleetOverview | null;
  loading: boolean;
  error: string | null;
  onNavigate(path: string): void;
}

export function DashboardOverview({
  projectName,
  items,
  workers,
  loading,
  error,
  onNavigate,
}: DashboardOverviewProps) {
  const running = items.filter((item) => item.status === "AI 正在实现").length;
  const pending = items.filter(
    (item) =>
      Object.keys(item.links.actions).length > 0 ||
      item.status === "等待产品验收" ||
      item.status === "验证失败，版本已封存",
  ).length;
  const connected = workers?.capacity.connectedAccounts ?? 0;
  const online =
    workers?.workers.filter((worker) => worker.status !== "离线").length ?? 0;

  const link = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
    event.preventDefault();
    onNavigate(path);
  };

  return (
    <div className="dashboard-overview">
      <header className="dashboard-hero">
        <div>
          <span className="eyebrow">SYSTEM OVERVIEW</span>
          <h1>ForgeX 运行总览</h1>
          <p>从业务目标到 Agent 执行与独立验收，关键状态集中在这里。</p>
        </div>
        <div className="hero-status">
          <PulseIcon />
          <span>
            <small>CONTROL PLANE</small>
            <strong>{error ? "部分数据异常" : "平台运行正常"}</strong>
          </span>
        </div>
      </header>

      {error ? (
        <div className="page-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="dashboard-grid" aria-label="平台概况">
        <article className="dashboard-card primary-card">
          <span className="dashboard-card-icon">
            <RequirementIcon />
          </span>
          <span>业务需求</span>
          <strong>{loading ? "—" : items.length}</strong>
          <small>
            {running > 0
              ? `${running} 项正在由 AI 实现`
              : "当前没有执行中的需求"}
          </small>
          <a
            href="/requirements"
            onClick={(event) => link(event, "/requirements")}
          >
            查看需求
          </a>
        </article>
        <article className="dashboard-card">
          <span className="dashboard-card-icon">
            <AgentIcon />
          </span>
          <span>Agent 账户</span>
          <strong>{connected} 个 / 不限数量</strong>
          <small>{online} 台设备在线，可继续连接新的 Agent</small>
          <a href="/agents" onClick={(event) => link(event, "/agents")}>
            管理 Agent
          </a>
        </article>
        <article className="dashboard-card">
          <span className="dashboard-card-icon">
            <ApprovalIcon />
          </span>
          <span>待确认事项</span>
          <strong>{loading ? "—" : pending}</strong>
          <small>外部操作和验收仍由人员做最终判断</small>
          <a href="/approvals" onClick={(event) => link(event, "/approvals")}>
            进入确认中心
          </a>
        </article>
        <article className="dashboard-card">
          <span className="dashboard-card-icon">
            <CheckIcon />
          </span>
          <span>安全边界</span>
          <strong className="text-metric">已保护</strong>
          <small>生产写入、凭据和验证结论保持隔离</small>
          <span className="dashboard-card-state">策略在线</span>
        </article>
      </section>

      <section className="dashboard-foundation">
        <div className="section-heading">
          <div>
            <span className="eyebrow">FOUNDATION</span>
            <h2>基础信息</h2>
          </div>
          <span className="filter-button">实时状态</span>
        </div>
        <dl>
          <div>
            <dt>当前项目</dt>
            <dd>{projectName}</dd>
          </div>
          <div>
            <dt>交付引擎</dt>
            <dd>ForgeX Agent</dd>
          </div>
          <div>
            <dt>验证策略</dt>
            <dd>独立 Runner 验证</dd>
          </div>
          <div>
            <dt>生产操作</dt>
            <dd>人工审批后执行</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
