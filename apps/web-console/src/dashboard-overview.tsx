import { useEffect, useState } from "react";
import type { LifecycleView } from "@forgex/contracts/lifecycle";
import type { ForgeXClient } from "./api.js";
import {
  lifecycleNextStep,
  lifecycleActionLabel,
  needsLifecycleAction,
} from "./lifecycle-presentation.js";
import {
  ApprovalIcon,
  RequirementIcon,
  PulseIcon,
  CheckIcon,
} from "./icons.js";
export function DashboardOverview({
  client,
  projectName,
  onNavigate,
}: {
  client: ForgeXClient;
  projectName: string;
  onNavigate(path: string): void;
}) {
  const [items, setItems] = useState<LifecycleView[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!client.lifecycle)
          throw new Error("完整交付数据暂不可用，请检查控制面连接");
        const list = await client.lifecycle.list();
        if (!stopped) {
          setItems(list);
          setError(null);
          setUpdated(new Date());
        }
      } catch (caught) {
        if (!stopped)
          setError(
            caught instanceof Error ? caught.message : "交付信息暂时无法读取",
          );
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client]);
  const mine = items.filter(needsLifecycleAction),
    blocked = items.filter((i) => i.blockedReason),
    active = items.filter((i) => i.stage !== "closed"),
    closed = items.filter((i) => i.stage === "closed");
  const open = (item: LifecycleView) =>
    onNavigate(`/delivery?workflow=${item.workflowKey}`);
  return (
    <div className="dashboard-overview delivery-dashboard">
      <header className="dashboard-hero">
        <div>
          <span className="eyebrow">你的交付工作台</span>
          <h1>今天，推进哪一项交付？</h1>
          <p>{projectName} · 先处理待审批与阻塞，让团队继续向前。</p>
        </div>
        <button
          className="button primary"
          onClick={() => onNavigate("/delivery?create=1")}
        >
          ＋ 提出需求
        </button>
      </header>
      {error ? (
        <div className="page-error" role="alert">
          {error}
          {updated ? (
            <small>当前展示上次成功读取的记录，暂未确认最新状态。</small>
          ) : null}
        </div>
      ) : null}
      <section className="dashboard-grid" aria-label="交付概况">
        {[
          {
            label: "待我处理",
            count: mine.length,
            icon: <ApprovalIcon />,
            tone: "attention",
          },
          {
            label: "进行中的交付",
            count: active.length,
            icon: <RequirementIcon />,
            tone: "running",
          },
          {
            label: "需要排障",
            count: blocked.length,
            icon: <PulseIcon />,
            tone: "danger",
          },
          {
            label: "已完成交付",
            count: closed.length,
            icon: <CheckIcon />,
            tone: "success",
          },
        ].map((card) => (
          <article className={`dashboard-card ${card.tone}`} key={card.label}>
            <div className="dashboard-card-top">
              <span>{card.label}</span>
              {card.icon}
            </div>
            <strong>{loading || (!updated && error) ? "—" : card.count}</strong>
            <small>
              {card.label === "待我处理"
                ? "对应你当前岗位的审批与处理"
                : card.label === "需要排障"
                  ? "先核对执行结果，再决定恢复"
                  : "来自完整交付流程的实际记录"}
            </small>
          </article>
        ))}
      </section>
      <div className="delivery-dashboard-columns">
        <section className="lifecycle-card dashboard-todos">
          <div className="section-heading">
            <div>
              <span className="eyebrow">下一步由你确认</span>
              <h2>我的待办</h2>
            </div>
            <button
              className="button secondary"
              onClick={() => onNavigate("/approvals")}
            >
              查看全部审批
            </button>
          </div>
          {loading ? (
            <p role="status">正在汇总待办…</p>
          ) : mine.length ? (
            mine.slice(0, 6).map((item) => (
              <button
                className="dashboard-work-item"
                type="button"
                key={item.workflowKey}
                aria-label={`${lifecycleActionLabel(item)}：${item.title}`}
                onClick={() => open(item)}
              >
                <span className="dashboard-work-icon">
                  <ApprovalIcon />
                </span>
                <span>
                  <strong>{item.title}</strong>
                  <small>{lifecycleNextStep(item)}</small>
                </span>
                <span className="delivery-state review">
                  {lifecycleActionLabel(item)} →
                </span>
              </button>
            ))
          ) : (
            <div className="delivery-empty">
              <strong>
                {error ? "暂时无法确认待办" : "当前没有待你处理的事项"}
              </strong>
              <p>
                {error
                  ? "恢复连接后将自动重新读取。"
                  : "可以查看进行中的交付，或提出一个新的业务需求。"}
              </p>
            </div>
          )}
        </section>
        <section className="lifecycle-card dashboard-blockers">
          <span className="eyebrow">团队需要关注</span>
          <h2>阻塞事项</h2>
          {blocked.length ? (
            blocked.slice(0, 4).map((item) => (
              <button
                className="dashboard-work-item"
                key={item.workflowKey}
                onClick={() => open(item)}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.blockedReason}</small>
                </span>
                <span>查看 →</span>
              </button>
            ))
          ) : (
            <div className="delivery-empty">
              <CheckIcon />
              <p>{error ? "阻塞状态暂未确认" : "当前记录中没有阻塞交付"}</p>
            </div>
          )}
          <div className="dashboard-sync">
            <span className={error ? "attention-dot" : "sync-dot"} />
            {updated
              ? `最近读取 ${updated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
              : "等待读取交付数据"}
          </div>
        </section>
      </div>
      <section className="lifecycle-card dashboard-recent">
        <div className="section-heading">
          <h2>近期交付</h2>
          <button
            className="button secondary"
            onClick={() => onNavigate("/delivery")}
          >
            查看交付列表
          </button>
        </div>
        {items.length ? (
          <div className="dashboard-recent-list">
            {items.slice(0, 5).map((item) => (
              <button
                type="button"
                key={item.workflowKey}
                onClick={() => open(item)}
              >
                <strong>{item.title}</strong>
                <span>{item.stageLabel}</span>
                <small>
                  {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p className="delivery-quiet">
            {error
              ? "交付记录暂不可用"
              : "提出第一项需求，开始建立可追踪的交付记录。"}
          </p>
        )}
      </section>
    </div>
  );
}
