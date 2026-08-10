import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ForgeXClient,
  WorkerFleetOverview,
  WorkerListItem,
} from "./api.js";

interface WorkerCenterProps {
  client: ForgeXClient;
}

const workerTone = (status: WorkerListItem["status"]) => {
  if (status === "正在工作") return "running";
  if (status === "空闲") return "success";
  return "neutral";
};

export function WorkerCenter({ client }: WorkerCenterProps) {
  const [overview, setOverview] = useState<WorkerFleetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listWorkers();
      if (generation === generationRef.current) setOverview(result);
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "暂时无法读取设备状态，请稍后重试",
        );
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const counts = useMemo(() => {
    const workers = overview?.workers ?? [];
    return {
      online: workers.filter((worker) => worker.status !== "离线").length,
      working: workers.filter((worker) => worker.status === "正在工作").length,
      idle: workers.filter((worker) => worker.status === "空闲").length,
    };
  }, [overview]);

  return (
    <div className="worker-center">
      <header className="topbar worker-topbar">
        <div>
          <span className="eyebrow">Codex 并行交付</span>
          <h1>设备中心</h1>
          <p>每个账户独立登录在客户设备上，平台只调度任务，不接管登录凭据。</p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "正在刷新…" : "刷新状态"}
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

      {loading && !overview ? (
        <div className="loading-state" role="status">
          正在汇总设备状态…
        </div>
      ) : overview ? (
        <>
          <section className="fleet-capacity" aria-label="账户容量">
            <div>
              <span className="eyebrow">当前容量</span>
              <h2>{`${overview.capacity.connectedAccounts} / ${overview.capacity.maxAccounts} 个账户已连接`}</h2>
              <p>
                {overview.capacity.availableSlots > 0
                  ? `还有 ${overview.capacity.availableSlots} 个可用槽位`
                  : "五个账户槽位已经全部使用"}
              </p>
            </div>
            <div className="slot-track" aria-hidden="true">
              {Array.from(
                { length: overview.capacity.maxAccounts },
                (_, index) => (
                  <span
                    key={index}
                    className={
                      index < overview.capacity.connectedAccounts
                        ? "filled"
                        : ""
                    }
                  />
                ),
              )}
            </div>
          </section>

          <section className="fleet-summary" aria-label="设备运行概况">
            <div>
              <span>在线设备</span>
              <strong>{counts.online}</strong>
            </div>
            <div>
              <span>正在交付</span>
              <strong>{counts.working}</strong>
            </div>
            <div>
              <span>可接新任务</span>
              <strong>{counts.idle}</strong>
            </div>
          </section>

          <section className="content-section fleet-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">账户与设备</span>
                <h2>当前连接</h2>
              </div>
              <span className="filter-button">
                共 {overview.workers.length} 台
              </span>
            </div>

            {overview.workers.length === 0 ? (
              <div className="empty-state compact">
                <h3>还没有设备连接</h3>
                <p>
                  管理员在客户设备上启动 ForgeX Agent 后，状态会出现在这里。
                </p>
              </div>
            ) : (
              <div className="worker-grid">
                {overview.workers.map((worker, index) => (
                  <article
                    className="worker-card"
                    key={`${worker.deviceName}:${worker.accountName}:${index}`}
                  >
                    <div className="worker-card-heading">
                      <span
                        className={`device-orb ${workerTone(worker.status)}`}
                      >
                        {worker.deviceName.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{worker.deviceName}</strong>
                        <span>{worker.accountName}</span>
                      </div>
                      <span
                        className={`status-pill ${workerTone(worker.status)}`}
                      >
                        {worker.status}
                      </span>
                    </div>
                    <p className="worker-current-work">
                      {worker.status === "正在工作" && worker.currentWork
                        ? `正在处理：${worker.currentWork}`
                        : worker.status === "空闲"
                          ? "已准备好接收下一项需求"
                          : "等待设备重新连接"}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
