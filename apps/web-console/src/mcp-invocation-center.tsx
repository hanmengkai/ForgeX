import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ForgeXClient, McpInvocationListItem } from "./api.js";

interface McpInvocationCenterProps {
  client: ForgeXClient;
}

const tone = (status: McpInvocationListItem["status"]): string => {
  if (status === "执行完成") return "success";
  if (status === "正在执行" || status === "等待设备执行") return "running";
  if (
    status === "等待产品确认" ||
    status === "执行未成功" ||
    status === "结果待人工核对"
  ) {
    return "attention";
  }
  return "neutral";
};

const formatTime = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

export function McpInvocationCenter({ client }: McpInvocationCenterProps) {
  const [items, setItems] = useState<McpInvocationListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const generationRef = useRef(0);
  const actionActiveRef = useRef(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listMcpInvocations();
      if (generation === generationRef.current) setItems(result);
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "暂时无法读取操作确认，请稍后重试",
        );
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [load]);

  const counts = useMemo(
    () => ({
      waiting: items.filter((item) => item.status === "等待产品确认").length,
      running: items.filter(
        (item) => item.status === "等待设备执行" || item.status === "正在执行",
      ).length,
      finished: items.filter((item) => item.status === "执行完成").length,
    }),
    [items],
  );

  const approve = async (item: McpInvocationListItem) => {
    const actionUrl = item.links.actions.approve;
    if (actionActiveRef.current || !actionUrl) return;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      await client.approveMcpInvocation(actionUrl);
      if (mountedRef.current) await load();
    } catch (caught) {
      if (mountedRef.current) {
        setError(
          caught instanceof Error ? caught.message : "确认没有完成，请重试",
        );
      }
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const cancel = async (item: McpInvocationListItem) => {
    const actionUrl = item.links.actions.cancel;
    if (actionActiveRef.current || !actionUrl) return;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      await client.cancelMcpInvocation(actionUrl);
      if (mountedRef.current) await load();
    } catch (caught) {
      if (mountedRef.current) {
        setError(
          caught instanceof Error ? caught.message : "取消没有完成，请重试",
        );
      }
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  return (
    <div className="invocation-center">
      <header className="topbar invocation-topbar">
        <div>
          <span className="eyebrow">受控外部操作</span>
          <h1>操作确认</h1>
          <p>
            看清业务动作和影响后再确认，内部连接、工具编码和凭据不会出现在这里。
          </p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={loading || busyAction !== null}
          onClick={() => void load()}
        >
          {loading ? "正在刷新…" : "刷新操作"}
        </button>
      </header>

      {error ? (
        <div className="page-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      ) : null}

      <section className="invocation-summary" aria-label="操作概况">
        <div>
          <span>等我确认</span>
          <strong>{counts.waiting}</strong>
        </div>
        <div>
          <span>执行队列</span>
          <strong>{counts.running}</strong>
        </div>
        <div>
          <span>已经完成</span>
          <strong>{counts.finished}</strong>
        </div>
      </section>

      {loading && items.length === 0 ? (
        <div className="loading-state" role="status">
          正在整理需要确认的操作…
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state compact">
          <h2>目前没有外部操作</h2>
          <p>AI 需要调用项目外部能力时，会把可理解的业务动作放到这里。</p>
        </div>
      ) : (
        <section
          className="content-section invocation-list"
          aria-label="外部操作"
        >
          <div className="section-heading">
            <div>
              <h2>最近操作</h2>
              <p>最多展示最近 100 项，确认入口完全由服务端权限决定。</p>
            </div>
          </div>
          <div className="invocation-grid">
            {items.map((item) => {
              const approveUrl = item.links.actions.approve;
              const cancelUrl = item.links.actions.cancel;
              return (
                <article className="invocation-card" key={item.links.self}>
                  <div className="invocation-card-heading">
                    <div>
                      <small>{item.serviceName}</small>
                      <h3>{item.title}</h3>
                    </div>
                    <span className={`status-pill ${tone(item.status)}`}>
                      {item.status}
                    </span>
                  </div>
                  <p>{item.detail}</p>
                  {item.inputs.length > 0 ? (
                    <dl className="invocation-inputs">
                      {item.inputs.map((input) => (
                        <div key={input.label}>
                          <dt>{input.label}</dt>
                          <dd dir="auto">
                            {input.sensitive ? (
                              "已安全提供"
                            ) : input.display === "list" ? (
                              <ul>
                                {input.values.map((value, index) => (
                                  <li dir="auto" key={`${index}:${value}`}>
                                    {value}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              input.values[0]
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  <div className="invocation-card-meta">
                    <span>{item.requestedBy}发起</span>
                    <time dateTime={item.requestedAt}>
                      {formatTime(item.requestedAt)}
                    </time>
                  </div>
                  {approveUrl || cancelUrl ? (
                    <div className="invocation-card-actions">
                      {approveUrl ? (
                        <button
                          className="button primary invocation-approve"
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void approve(item)}
                        >
                          {busyAction === approveUrl
                            ? "正在确认…"
                            : `确认${item.title}并交给设备执行`}
                        </button>
                      ) : null}
                      {cancelUrl ? (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() => void cancel(item)}
                        >
                          {busyAction === cancelUrl
                            ? "正在取消…"
                            : item.status === "已取消"
                              ? "继续完成取消"
                              : "不执行这项操作"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
