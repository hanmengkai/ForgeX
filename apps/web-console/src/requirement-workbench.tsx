import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ForgeXClient,
  RequirementActionLinks,
  RequirementDetail,
  RequirementListItem,
} from "./api.js";
import { CreateRequirementDialog } from "./create-requirement-dialog.js";
import { ArrowIcon, CheckIcon, PlusIcon, SparkIcon } from "./icons.js";
import { WorkerCenter } from "./worker-center.js";

interface RequirementWorkbenchProps {
  client: ForgeXClient;
  projectName?: string;
}

const actionEntries = (
  actions: RequirementActionLinks,
): Array<{
  key: keyof RequirementActionLinks;
  label: string;
  url: string;
  body: Record<string, unknown>;
}> => [
  ...(actions.submitConfirmation
    ? [
        {
          key: "submitConfirmation" as const,
          label: "提交确认",
          url: actions.submitConfirmation,
          body: {},
        },
      ]
    : []),
  ...(actions.confirm
    ? [
        {
          key: "confirm" as const,
          label: "确认需求",
          url: actions.confirm,
          body: {},
        },
      ]
    : []),
  ...(actions.startDelivery
    ? [
        {
          key: "startDelivery" as const,
          label: "安排 AI 开始实现",
          url: actions.startDelivery,
          body: { schemaVersion: 1, requiredCapabilities: [] },
        },
      ]
    : []),
];

const statusTone = (status: RequirementListItem["status"]) => {
  if (status === "已完成") return "success";
  if (status === "AI 正在实现") return "running";
  if (status.includes("等待") || status.includes("确认")) return "attention";
  return "neutral";
};

function RequirementCard({
  item,
  busyAction,
  actionsBusy,
  detail,
  detailError,
  detailLoading,
  expanded,
  onAction,
  onToggleDetail,
}: {
  item: RequirementListItem;
  busyAction: string | null;
  actionsBusy: boolean;
  detail: RequirementDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  expanded: boolean;
  onAction(actionUrl: string, body: Record<string, unknown>): Promise<void>;
  onToggleDetail(selfUrl: string): Promise<void>;
}) {
  const actions = actionEntries(item.links.actions);
  return (
    <article className="requirement-card">
      <button
        className="card-main"
        type="button"
        aria-label={`${expanded ? "收起" : "查看"}${item.title}详情`}
        aria-expanded={expanded}
        onClick={() => void onToggleDetail(item.links.self)}
      >
        <span className={`status-dot ${statusTone(item.status)}`} />
        <span className="card-copy">
          <span className="card-title-row">
            <strong>{item.title}</strong>
            <span className="version">{item.version}</span>
          </span>
          <span className="card-summary">{item.summary}</span>
          <span className="card-meta">
            <span className={`status-pill ${statusTone(item.status)}`}>
              {item.status}
            </span>
            <span>{item.nextStep}</span>
          </span>
        </span>
        <ArrowIcon />
      </button>
      {expanded ? (
        <div className="card-detail" aria-live="polite">
          {detailLoading ? <p>正在读取需求详情…</p> : null}
          {detailError ? <p className="detail-error">{detailError}</p> : null}
          {detail ? (
            <>
              <div>
                <span className="detail-label">要解决的问题</span>
                <p>{detail.spec.goal}</p>
              </div>
              <div>
                <span className="detail-label">完成标准</span>
                <ul>
                  {detail.spec.acceptanceCriteria.map((criterion) => (
                    <li key={`${criterion.title}:${criterion.description}`}>
                      <strong>{criterion.title}</strong>
                      <span>{criterion.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {actions.length > 0 ? (
        <div className="card-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              className="text-action"
              type="button"
              disabled={actionsBusy}
              onClick={() => onAction(action.url, action.body)}
            >
              {busyAction === action.url ? "正在处理…" : action.label}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function RequirementWorkbench({
  client,
  projectName = "我的项目",
}: RequirementWorkbenchProps) {
  const [items, setItems] = useState<RequirementListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeView, setActiveView] = useState<"workbench" | "workers">(
    "workbench",
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequirementDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const actionActiveRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setError(null);
    try {
      const result = await client.listRequirements();
      if (generation === loadGenerationRef.current) {
        setItems(result.items);
      }
    } catch (caught) {
      if (generation === loadGenerationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "暂时无法读取需求，请稍后重试",
        );
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      detailGenerationRef.current += 1;
    };
  }, [load]);

  const summary = useMemo(
    () => ({
      needsAction: items.filter(
        (item) => Object.keys(item.links.actions).length > 0,
      ).length,
      running: items.filter((item) => item.status === "AI 正在实现").length,
      accepting: items.filter((item) => item.status === "等待产品验收").length,
      completed: items.filter((item) => item.status === "已完成").length,
    }),
    [items],
  );

  const runAction = async (
    actionUrl: string,
    body: Record<string, unknown>,
  ) => {
    if (actionActiveRef.current) return;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      await client.runRequirementAction(actionUrl, body);
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "操作没有完成，请重试",
      );
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const toggleDetail = async (selfUrl: string) => {
    if (expandedDetail === selfUrl) {
      detailGenerationRef.current += 1;
      setExpandedDetail(null);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const generation = ++detailGenerationRef.current;
    setExpandedDetail(selfUrl);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await client.getRequirement(selfUrl);
      if (generation === detailGenerationRef.current) setDetail(result);
    } catch (caught) {
      if (generation === detailGenerationRef.current) {
        setDetailError(
          caught instanceof Error ? caught.message : "暂时无法读取需求详情",
        );
      }
    } finally {
      if (generation === detailGenerationRef.current) setDetailLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <SparkIcon />
          </span>
          <span>
            <strong>ForgeX</strong>
            <small>AI 交付工作台</small>
          </span>
        </div>
        <div className="project-chip">
          <span className="project-avatar">{projectName.slice(0, 1)}</span>
          <span>
            <small>当前项目</small>
            <strong>{projectName}</strong>
          </span>
        </div>
        <nav aria-label="主导航">
          <button
            className={`nav-item ${activeView === "workbench" ? "active" : ""}`}
            type="button"
            aria-label="工作台"
            aria-current={activeView === "workbench" ? "page" : undefined}
            onClick={() => setActiveView("workbench")}
          >
            <span>⌂</span>工作台
          </button>
          <button
            className="nav-item"
            type="button"
            aria-label="需求"
            onClick={() => setActiveView("workbench")}
          >
            <span>◫</span>需求
          </button>
          <button
            className={`nav-item ${activeView === "workers" ? "active" : ""}`}
            type="button"
            aria-label="设备中心"
            aria-current={activeView === "workers" ? "page" : undefined}
            onClick={() => setActiveView("workers")}
          >
            <span>⌘</span>设备中心
          </button>
          <span className="nav-item disabled" aria-disabled="true">
            <span>✓</span>质量与验收
          </span>
          <span className="nav-item disabled" aria-disabled="true">
            <span>◇</span>扩展中心
          </span>
        </nav>
        <div className="sidebar-note">
          <CheckIcon />
          <span>
            <strong>交付边界已保护</strong>
            <small>生产操作仍需人工审批</small>
          </span>
        </div>
      </aside>

      <main
        className="workspace"
        id={activeView === "workbench" ? "workbench" : "workers"}
      >
        {activeView === "workers" ? (
          <WorkerCenter client={client} />
        ) : (
          <>
            <header className="topbar">
              <div>
                <span className="eyebrow">今天的交付概况</span>
                <h1>你好，欢迎回来</h1>
                <p>先处理需要判断的事项，其余工作交给 AI 和独立验证流程。</p>
              </div>
              <button
                className="button primary"
                type="button"
                onClick={() => setCreating(true)}
              >
                <PlusIcon />
                新建需求
              </button>
            </header>

            <section className="summary-grid" aria-label="需求概况">
              <div className="summary-card attention">
                <span>需要我处理</span>
                <strong>{summary.needsAction}</strong>
                <small>确认或安排交付</small>
              </div>
              <div className="summary-card running">
                <span>AI 正在执行</span>
                <strong>{summary.running}</strong>
                <small>设备并行处理中</small>
              </div>
              <div className="summary-card neutral">
                <span>等待我验收</span>
                <strong>{summary.accepting}</strong>
                <small>可查看真实效果</small>
              </div>
              <div className="summary-card success">
                <span>本轮已完成</span>
                <strong>{summary.completed}</strong>
                <small>证据链完整</small>
              </div>
            </section>

            <section className="content-section" id="requirements">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">需求主线</span>
                  <h2>正在推进的工作</h2>
                </div>
                <span className="filter-button">共 {items.length} 项</span>
              </div>

              {error ? (
                <div className="page-error" role="alert">
                  {error}
                  <button type="button" onClick={() => void load()}>
                    重新加载
                  </button>
                </div>
              ) : null}
              {loading ? (
                <div className="loading-state" role="status">
                  正在整理需求进度…
                </div>
              ) : items.length === 0 && !error ? (
                <div className="empty-state">
                  <SparkIcon />
                  <h3>从第一个业务目标开始</h3>
                  <p>创建需求后，ForgeX 会引导确认、实现和验证。</p>
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => setCreating(true)}
                  >
                    新建需求
                  </button>
                </div>
              ) : items.length > 0 ? (
                <div className="requirement-list">
                  {items.map((item) => (
                    <RequirementCard
                      key={item.links.self}
                      item={item}
                      busyAction={busyAction}
                      actionsBusy={busyAction !== null}
                      expanded={expandedDetail === item.links.self}
                      detail={
                        expandedDetail === item.links.self ? detail : null
                      }
                      detailError={
                        expandedDetail === item.links.self ? detailError : null
                      }
                      detailLoading={
                        expandedDetail === item.links.self && detailLoading
                      }
                      onAction={runAction}
                      onToggleDetail={toggleDetail}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          </>
        )}
      </main>

      {creating ? (
        <CreateRequirementDialog
          client={client}
          onClose={() => setCreating(false)}
          onCreated={load}
        />
      ) : null}
    </div>
  );
}
