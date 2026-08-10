import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ForgeXClient,
  WorkerEnrollmentSetup,
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
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [connectionSetup, setConnectionSetup] =
    useState<WorkerEnrollmentSetup | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"command" | "token" | null>(null);
  const generationRef = useRef(0);
  const savingRef = useRef(false);

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

  const enrollmentCommand = useMemo(
    () =>
      connectionSetup
        ? `npm run --workspace @forgex/device-worker enroll -- --control-plane ${window.location.origin}`
        : "",
    [connectionSetup],
  );

  const submitConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || !overview?.connectAction) return;
    savingRef.current = true;
    setSaving(true);
    setConnectionError(null);
    try {
      const result = await client.connectWorker(overview.connectAction, {
        deviceName: deviceName.trim(),
        accountName: accountName.trim(),
      });
      setConnectionSetup(result);
      setConnecting(false);
    } catch (caught) {
      setConnectionError(
        caught instanceof Error
          ? caught.message
          : "暂时无法生成设备连接配置，请稍后重试",
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const closeConnectionSetup = () => {
    setConnectionSetup(null);
    setDeviceName("");
    setAccountName("");
    setCopied(null);
  };

  const copyValue = async (value: string, kind: "command" | "token") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setConnectionError("浏览器无法自动复制，请手动选择下方配置");
    }
  };

  return (
    <div className="worker-center">
      <header className="topbar worker-topbar">
        <div>
          <span className="eyebrow">Codex 并行交付</span>
          <h1>设备中心</h1>
          <p>每个账户独立登录在客户设备上，平台只调度任务，不接管登录凭据。</p>
        </div>
        <div className="worker-actions">
          {overview?.connectAction && overview.capacity.availableSlots > 0 ? (
            <button
              className="button primary"
              type="button"
              onClick={() => {
                setConnecting((value) => !value);
                setConnectionError(null);
              }}
            >
              {connecting ? "收起连接表单" : "连接新设备"}
            </button>
          ) : null}
          <button
            className="button secondary"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "正在刷新…" : "刷新状态"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="page-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      ) : null}

      {connecting ? (
        <section className="content-section worker-connect-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">仅管理员可操作</span>
              <h2>连接一台 Codex 设备</h2>
              <p>这里只登记设备昵称，不接收 Codex 登录凭据。</p>
            </div>
          </div>
          <form onSubmit={(event) => void submitConnection(event)}>
            <label className="field" htmlFor="worker-device-name">
              设备名称
              <input
                id="worker-device-name"
                required
                minLength={2}
                maxLength={100}
                value={deviceName}
                disabled={saving}
                placeholder="例如：研发电脑 1"
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
            <label className="field" htmlFor="worker-account-name">
              Codex 账户昵称
              <input
                id="worker-account-name"
                required
                minLength={2}
                maxLength={100}
                value={accountName}
                disabled={saving}
                placeholder="例如：团队 Codex 账户 1"
                onChange={(event) => setAccountName(event.target.value)}
              />
              <small>用于团队识别，不要填写邮箱、密码或 Token。</small>
            </label>
            {connectionError ? (
              <p className="form-error" role="alert">
                {connectionError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                className="button primary"
                type="submit"
                disabled={saving}
              >
                {saving ? "正在生成…" : "生成连接配置"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {connectionSetup ? (
        <section className="content-section worker-credential-panel">
          <span className="eyebrow">只显示这一次</span>
          <h2>设备接入码已生成</h2>
          <p>
            先在目标设备设置 <code>FORGEX_WORKER_CONFIG</code>{" "}
            指向已填写本机路径的配置示例，
            再从仓库根目录执行下面命令，并按无回显提示粘贴接入码。 CLI
            会在配置同一私有目录保存稳定身份；接入码不会进入进程参数或 Shell
            历史，十分钟后失效。
          </p>
          <textarea
            aria-label="一次性设备接入码"
            readOnly
            rows={2}
            value={connectionSetup.enrollmentToken}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            className="button secondary compact-copy"
            type="button"
            onClick={() =>
              void copyValue(connectionSetup.enrollmentToken, "token")
            }
          >
            {copied === "token" ? "接入码已复制" : "复制后在 CLI 提示中粘贴"}
          </button>
          <textarea
            aria-label="设备接入命令"
            readOnly
            rows={5}
            value={enrollmentCommand}
            onFocus={(event) => event.currentTarget.select()}
          />
          {connectionError ? (
            <p className="form-error" role="alert">
              {connectionError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => void copyValue(enrollmentCommand, "command")}
            >
              {copied === "command" ? "命令已复制" : "复制接入命令"}
            </button>
            <button
              className="button primary"
              type="button"
              onClick={closeConnectionSetup}
            >
              我已保存，关闭
            </button>
          </div>
        </section>
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
