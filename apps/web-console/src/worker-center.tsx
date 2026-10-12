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
import { DownloadIcon } from "./icons.js";
import type { LifecycleWorkerView } from "@forgex/contracts/lifecycle";

interface WorkerCenterProps {
  client: ForgeXClient;
  initialOverview?: WorkerFleetOverview | null;
}

const workerTone = (status: WorkerListItem["status"]) => {
  if (status === "正在工作") return "running";
  if (status === "空闲") return "success";
  return "neutral";
};

export function WorkerCenter({
  client,
  initialOverview = null,
}: WorkerCenterProps) {
  const [overview, setOverview] = useState<WorkerFleetOverview | null>(
    initialOverview,
  );
  const [executors, setExecutors] = useState<LifecycleWorkerView[] | null>(
      null,
    ),
    [executorError, setExecutorError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialOverview === null);
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
    if (client.lifecycle?.workers) {
      try {
        const result = await client.lifecycle.workers();
        if (generation === generationRef.current) {
          setExecutors(result);
          setExecutorError(null);
        }
      } catch (caught) {
        if (generation === generationRef.current)
          setExecutorError(
            caught instanceof Error ? caught.message : "交付执行器状态暂不可用",
          );
      }
    }
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
    if (!initialOverview || client.lifecycle?.workers) void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      generationRef.current += 1;
      clearInterval(timer);
    };
  }, [initialOverview, load]);

  const agentDownloadUrl =
    import.meta.env.VITE_FORGEX_AGENT_DOWNLOAD_URL ??
    "https://gitee.com/hmk_855_admin/forge-x/repository/archive/master.zip";

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
          <span className="eyebrow">团队执行能力</span>
          <h1>执行器管理</h1>
          <p>
            查看谁能接任务、谁正在执行、哪里需要处理。Codex 登录保留在本机。
          </p>
        </div>
        <div className="worker-actions">
          {overview?.connectAction ? (
            <button
              className="button primary"
              type="button"
              onClick={() => {
                setConnecting((value) => !value);
                setConnectionError(null);
              }}
            >
              {connecting ? "收起连接表单" : "连接传统设备"}
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

      {error && !executors ? (
        <div className="page-error" role="alert">
          {error}
          <button type="button" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      ) : null}
      {executorError ? (
        <div className="page-error" role="alert">
          {executorError}；当前展示的历史状态尚未重新确认。
        </div>
      ) : null}
      {executors ? (
        <section
          className="content-section execution-fleet"
          aria-label="交付执行器"
        >
          <div className="fleet-summary">
            <div>
              <span>已登记执行器</span>
              <strong>{executors.length}</strong>
            </div>
            <div>
              <span>正在执行</span>
              <strong>
                {executorError
                  ? "—"
                  : executors.filter((e) => e.status === "working").length}
              </strong>
            </div>
            <div>
              <span>可接新任务</span>
              <strong>
                {executorError
                  ? "—"
                  : executors.filter(
                      (e) =>
                        e.status === "idle" &&
                        (e.loginState === "logged_in" ||
                          e.loginState === "not_required"),
                    ).length}
              </strong>
            </div>
          </div>
          <div className="worker-grid">
            {executors.map((executor) => (
              <article className="worker-card" key={executor.executorKey}>
                <div className="worker-card-heading">
                  <span className="device-orb running">
                    {executor.provider === "codex" ? "C" : "⚙"}
                  </span>
                  <div>
                    <strong>{executor.displayName}</strong>
                    <span>
                      {executor.provider === "codex"
                        ? "Codex"
                        : executor.provider === "sample"
                          ? "隔离样板"
                          : executor.provider === "controlled_pipeline"
                            ? "受控交付流程"
                            : "执行方式尚未核对"}
                    </span>
                  </div>
                  <span
                    className={`status-pill ${executor.status === "working" ? "running" : executor.status === "idle" ? "success" : "neutral"}`}
                  >
                    {executorError
                      ? "状态待核对"
                      : {
                          idle: "在线空闲",
                          working: "正在执行",
                          offline: "已离线",
                          not_connected: "尚未连接",
                          awaiting_confirmation: "等待回执确认",
                        }[executor.status]}
                  </span>
                </div>
                <p className="worker-current-work">
                  {executor.currentWork ??
                    (executor.status === "offline"
                      ? "等待执行端恢复心跳"
                      : executor.status === "not_connected"
                        ? "在设备上启动 Worker 后，状态会自动更新"
                        : "当前没有执行中的任务")}
                </p>
                <dl className="executor-facts">
                  <div>
                    <dt>登录核对</dt>
                    <dd>
                      {(executorError || executor.status === "offline"
                        ? "上次核对："
                        : "") +
                        {
                          logged_in: "本机 Codex 已登录",
                          needs_login: "需要在本机重新登录",
                          unknown: "尚未核对，不计入可接任务",
                          not_required: "固定受控流程，无需模型登录",
                        }[executor.loginState]}
                    </dd>
                  </div>
                  <div>
                    <dt>最近心跳</dt>
                    <dd>
                      {executor.lastSeenAt
                        ? new Date(executor.lastSeenAt).toLocaleTimeString(
                            "zh-CN",
                          )
                        : "尚无心跳记录"}
                    </dd>
                  </div>
                </dl>
                <div className="executor-capabilities">
                  {executor.capabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
                <details>
                  <summary>技术详情</summary>
                  <p>执行器标识：{executor.executorKey}</p>
                  <p>执行器身份指纹：{executor.identityFingerprint}</p>
                </details>
              </article>
            ))}
          </div>
          {!executors.length ? (
            <div className="delivery-empty">
              <strong>还没有登记交付执行器</strong>
              <p>管理员配置本机 Worker 后，这里会显示执行方式、能力和心跳。</p>
            </div>
          ) : null}
        </section>
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

      <details
        className="content-section agent-installation"
        open={!executors?.length && !overview?.workers.length}
      >
        <summary>管理员接入与安装说明</summary>
        <div className="agent-install-heading">
          <div>
            <span className="eyebrow">AGENT SETUP</span>
            <h2>安装 ForgeX Agent</h2>
            <p>安装包包含设备 Worker、配置示例和受控 Codex 启动器。</p>
          </div>
          <a
            className="button primary"
            href={agentDownloadUrl}
            target="_blank"
            rel="noreferrer"
          >
            <DownloadIcon />
            下载 Agent 安装包
          </a>
        </div>
        <ol className="agent-install-steps">
          <li>
            <strong>1. 下载并解压</strong>
            <span>把安装包放到仅 Agent 管理员可写的目录。</span>
          </li>
          <li>
            <strong>2. 准备运行环境</strong>
            <span>
              安装 Node.js 22，并复制填写{" "}
              <code>worker.config.example.json</code>。
            </span>
          </li>
          <li>
            <strong>3. 生成接入码</strong>
            <span>点击“连接新设备”，登记设备与 Codex 账户昵称。</span>
          </li>
          <li>
            <strong>4. 启动并验证</strong>
            <span>
              执行页面生成的接入命令，再启动 Worker 并确认状态为“空闲”。
            </span>
          </li>
        </ol>
        <p className="agent-install-note">
          Codex 登录在目标设备本地完成，ForgeX 控制面不会接收账号密码、Token
          或本地凭据文件。
        </p>
      </details>

      {loading && !overview ? (
        <div className="loading-state" role="status">
          正在汇总设备状态…
        </div>
      ) : overview && (!executors || overview.workers.length > 0) ? (
        <>
          <section className="fleet-capacity" aria-label="账户容量">
            <div>
              <span className="eyebrow">当前容量</span>
              <h2>{`${overview.capacity.connectedAccounts} 个账户已连接`}</h2>
              <p>Agent 数量不设上限，可继续按团队规模连接设备。</p>
            </div>
            <strong className="unlimited-capacity">不限数量</strong>
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
