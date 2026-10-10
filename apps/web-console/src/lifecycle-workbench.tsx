import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  lifecycleStageLabels,
  type LifecycleBug,
  type LifecycleContext,
  type LifecycleNotification,
  type LifecycleRole,
  type LifecycleStage,
  type LifecycleView,
} from "@forgex/contracts/lifecycle";
import type { ForgeXClient } from "./api.js";

const roles: Record<LifecycleRole, string> = {
  requester: "需求方",
  product_owner: "产品负责人",
  requirement_analyst: "需求分析师",
  developer: "研发负责人",
  tester: "测试负责人",
  test_ops: "测试运维",
  production_ops: "生产运维",
  administrator: "平台管理员",
};
const stages: LifecycleStage[] = [
  "requirements_ai",
  "requirements_review",
  "requester_confirmation",
  "design_ai",
  "design_review",
  "development",
  "code_review",
  "testing",
  "test_review",
  "staging_deploy",
  "staging_acceptance",
  "release_approval",
  "production_deploy",
  "online_acceptance",
  "closed",
];
const artifactLabels: Record<string, string> = {
  requirements: "需求方案",
  design: "设计方案",
  code: "代码与自测",
  tests: "独立测试报告",
  deployment: "环境部署",
  rollback: "生产恢复",
};
const jobLabels: Record<string, string> = {
  queued: "等待执行器",
  running: "正在执行",
  succeeded: "已执行成功",
  failed: "执行失败",
  blocked: "执行阻塞",
  cancelled: "本轮已取消",
};
const reworkOptions: Partial<
  Record<
    LifecycleStage,
    Array<{
      value:
        | "requirements"
        | "design"
        | "implementation"
        | "verification"
        | "deployment";
      label: string;
    }>
  >
> = {
  requirements_review: [{ value: "requirements", label: "重新澄清需求" }],
  requester_confirmation: [{ value: "requirements", label: "重新澄清需求" }],
  design_review: [
    { value: "design", label: "修改设计方案" },
    { value: "requirements", label: "重新确认需求" },
  ],
  code_review: [
    { value: "implementation", label: "修复实现" },
    { value: "design", label: "重新设计" },
  ],
  test_review: [
    { value: "verification", label: "重做测试" },
    { value: "implementation", label: "修复实现" },
  ],
  staging_acceptance: [
    { value: "implementation", label: "修复实现" },
    { value: "requirements", label: "变更需求" },
    { value: "design", label: "修改设计" },
    { value: "deployment", label: "重新部署测试环境" },
  ],
  release_approval: [
    { value: "implementation", label: "修复实现" },
    { value: "design", label: "修改设计" },
    { value: "requirements", label: "变更需求" },
  ],
};

export function LifecycleWorkbench({ client }: { client: ForgeXClient }) {
  const api = client.lifecycle;
  const [context, setContext] = useState<LifecycleContext | null>(null),
    [items, setItems] = useState<LifecycleView[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [flow, setFlow] = useState<LifecycleView | null>(null),
    [bugs, setBugs] = useState<LifecycleBug[]>([]),
    [notifications, setNotifications] = useState<LifecycleNotification[]>([]);
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [title, setTitle] = useState(""),
    [brief, setBrief] = useState(""),
    [reason, setReason] = useState(""),
    [role, setRole] = useState<LifecycleRole | "">("");
  const [rework, setRework] = useState(""),
    [bugTitle, setBugTitle] = useState(""),
    [bugDescription, setBugDescription] = useState(""),
    [severity, setSeverity] = useState<"critical" | "major" | "minor">("major");
  const busyRef = useRef(false),
    selectedRef = useRef<string | null>(null),
    generation = useRef(0),
    mounted = useRef(true);
  selectedRef.current = selected;
  const refresh = async () => {
    if (!api) return;
    const current = ++generation.current;
    const [nextContext, nextItems, nextNotifications] = await Promise.all([
      api.context(),
      api.list(),
      api.notifications(),
    ]);
    const key = selectedRef.current ?? nextItems[0]?.workflowKey ?? null;
    const detail = key ? await api.get(key) : null;
    const nextBugs = key ? await api.bugs(key) : [];
    if (!mounted.current || current !== generation.current) return;
    setContext(nextContext);
    setItems(nextItems);
    setNotifications(nextNotifications);
    setFlow(detail);
    setBugs(nextBugs);
    if (!selectedRef.current && key) setSelected(key);
    setLoading(false);
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "交付信息暂时无法读取",
          );
          setLoading(false);
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      cancelled = true;
      mounted.current = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [api, selected]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (
        result &&
        typeof result === "object" &&
        "stage" in result &&
        "workflowKey" in result
      ) {
        const next = result as LifecycleView;
        setFlow(next);
        selectedRef.current = next.workflowKey;
        setSelected(next.workflowKey);
      }
      await refresh();
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "操作没有完成，请重试",
      );
      try {
        await refresh();
      } catch {}
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !context) return;
    if (await run(() => api.create({ title, brief, context }))) {
      setTitle("");
      setBrief("");
    }
  };
  const activeRole = flow?.allowedRoles.includes(role as LifecycleRole)
    ? role
    : (flow?.allowedRoles[0] ?? "");
  const decide = (decision: "approve" | "reject" | "object") => {
    if (!api || !flow || !activeRole) return;
    const selectedRework = reworkOptions[flow.stage]?.find(
      (o) => o.value === rework,
    )?.value;
    void run(() =>
      api.decide(flow, {
        role: activeRole as LifecycleRole,
        decision,
        reason,
        ...(decision === "reject" && selectedRework
          ? { rework: selectedRework }
          : {}),
      }),
    ).then((ok) => {
      if (ok) {
        setReason("");
        setRework("");
      }
    });
  };
  const report = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !flow) return;
    if (
      await run(() =>
        api.reportBug(flow.workflowKey, {
          title: bugTitle,
          description: bugDescription,
          severity,
        }),
      )
    ) {
      setBugTitle("");
      setBugDescription("");
    }
  };
  if (!api)
    return (
      <section className="content-section">
        <p>当前客户端尚未启用完整交付流程。</p>
      </section>
    );
  return (
    <div className="lifecycle-workbench">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ForgeX 2.0</span>
          <h1>完整交付</h1>
          <p>从业务需求到三方线上验收，每个阶段都有明确结果和负责人。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>
          刷新进度
        </button>
      </div>
      {error ? (
        <p role="alert" className="lifecycle-error">
          {error}
        </p>
      ) : null}
      <div className="lifecycle-grid">
        <aside className="lifecycle-list">
          {context?.roles.some((r) =>
            ["requester", "product_owner", "requirement_analyst"].includes(r),
          ) ? (
            <form
              onSubmit={(event) => void create(event)}
              className="lifecycle-card"
            >
              <h2>提出需求</h2>
              <label>
                需求名称
                <input
                  required
                  minLength={2}
                  maxLength={500}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                业务目标与已有信息
                <textarea
                  required
                  minLength={2}
                  maxLength={10_000}
                  rows={4}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                />
              </label>
              <button disabled={busy || !context} type="submit">
                提交给需求 AI
              </button>
            </form>
          ) : null}
          <section className="lifecycle-card">
            <h2>交付列表</h2>
            {loading ? (
              <p>正在读取交付…</p>
            ) : !items.length ? (
              <p>还没有交付需求。</p>
            ) : (
              items.map((item) => (
                <button
                  className={`lifecycle-item ${item.workflowKey === selected ? "selected" : ""}`}
                  key={item.workflowKey}
                  type="button"
                  onClick={() => {
                    setReason("");
                    setRole("");
                    setRework("");
                    setSelected(item.workflowKey);
                  }}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.blockedReason ? "执行阻塞" : item.stageLabel}
                  </span>
                </button>
              ))
            )}
          </section>
          <section className="lifecycle-card">
            <h2>我的通知</h2>
            {notifications.length ? (
              notifications.map((n) => (
                <button
                  className="lifecycle-item"
                  key={n.notificationKey}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await api.readNotification(n.notificationKey);
                      selectedRef.current = n.workflowKey;
                      setSelected(n.workflowKey);
                    })
                  }
                >
                  <strong>
                    {n.read ? "" : "● "}
                    {n.title}
                  </strong>
                  <span>{n.detail}</span>
                </button>
              ))
            ) : (
              <p>暂时没有通知。</p>
            )}
          </section>
        </aside>
        <section className="lifecycle-detail" aria-label="交付详情">
          {flow ? (
            <>
              <div className="lifecycle-card">
                <h2>{flow.title}</h2>
                <p>{flow.brief}</p>
                <p>
                  <strong>{flow.stageLabel}</strong> · 需求第{" "}
                  {flow.requirementVersion} 版 · 设计第 {flow.designVersion} 版
                </p>
                {flow.sourceBugKey ? <p>这是关联缺陷的修复需求。</p> : null}
                <ol className="lifecycle-stages" aria-label="完整流程">
                  {stages.map((stage) => (
                    <li
                      key={stage}
                      className={
                        stage === flow.stage
                          ? "active"
                          : stages.indexOf(stage) < stages.indexOf(flow.stage)
                            ? "done"
                            : "pending"
                      }
                      aria-current={stage === flow.stage ? "step" : undefined}
                    >
                      {lifecycleStageLabels[stage]}
                    </li>
                  ))}
                </ol>
                {flow.currentJob ? (
                  <p role="status">
                    {flow.currentJob.stageLabel}：
                    {jobLabels[flow.currentJob.status]}，第{" "}
                    {flow.currentJob.attempt} 次执行
                  </p>
                ) : null}
                {flow.blockedReason ? (
                  <p role="alert" className="lifecycle-error">
                    {flow.blockedReason}
                  </p>
                ) : null}
                {flow.stage === "release_approval" ||
                flow.stage === "online_acceptance" ||
                flow.stage === "recovery_approval" ? (
                  <p>
                    需要研发、生产运维和本需求方三个不同的人分别确认。当前已确认：
                    {flow.approvals.map((a) => roles[a.role]).join("、") ||
                      "暂无"}
                    。
                  </p>
                ) : null}
                <details>
                  <summary>技术详情</summary>
                  <p>交付标识：{flow.workflowKey}</p>
                  <p>记录版本：{flow.version}</p>
                </details>
              </div>
              {flow.artifacts.map((artifact, index) => (
                <article
                  key={`${artifact.kind}-${index}`}
                  className="lifecycle-card"
                >
                  <h3>{artifactLabels[artifact.kind]}</h3>
                  <p>{artifact.summary}</p>
                  {artifact.content ? (
                    <pre className="lifecycle-content">{artifact.content}</pre>
                  ) : null}
                  {artifact.url ? (
                    <a
                      className="primary-button"
                      href={artifact.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开{artifact.summary.includes("生产") ? "线上" : "测试"}
                      环境
                    </a>
                  ) : null}
                  {artifact.checks.length ? (
                    <ul>
                      {artifact.checks.map((check, i) => (
                        <li key={i}>
                          {check.passed ? "已通过" : "未通过"}：{check.title}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {artifact.technical ? (
                    <details>
                      <summary>技术详情</summary>
                      {Object.entries(artifact.technical).map(
                        ([key, value]) => (
                          <p key={key}>
                            {key === "commitSha" ? "代码提交" : "制品摘要"}：
                            {value}
                          </p>
                        ),
                      )}
                    </details>
                  ) : null}
                </article>
              ))}
              {flow.allowedRoles.length || flow.allowedActions.length ? (
                <section className="lifecycle-card" aria-label="当前审核">
                  <h3>当前需要我的处理</h3>
                  {flow.allowedRoles.length > 1 ? (
                    <label>
                      本次确认身份
                      <select
                        value={activeRole}
                        onChange={(e) =>
                          setRole(e.target.value as LifecycleRole)
                        }
                      >
                        {flow.allowedRoles.map((r) => (
                          <option key={r} value={r}>
                            {roles[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : activeRole ? (
                    <p>确认身份：{roles[activeRole as LifecycleRole]}</p>
                  ) : null}
                  <label>
                    审核意见或处理结论
                    <textarea
                      value={reason}
                      rows={3}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="说明已核对的内容，或需要修改的问题"
                    />
                  </label>
                  {reworkOptions[flow.stage]?.length ? (
                    <label>
                      驳回后的处理
                      <select
                        value={rework}
                        onChange={(e) => setRework(e.target.value)}
                      >
                        <option value="">按当前阶段返工</option>
                        {reworkOptions[flow.stage]?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div className="lifecycle-actions">
                    {activeRole ? (
                      <>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            reason.trim().length < 2 ||
                            flow.objections.some((o) => !o.resolution)
                          }
                          onClick={() => decide("approve")}
                        >
                          审核通过
                        </button>
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 2}
                          onClick={() => decide("object")}
                        >
                          提出异议
                        </button>
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 2}
                          onClick={() => decide("reject")}
                        >
                          驳回返工
                        </button>
                      </>
                    ) : null}
                    {flow.allowedActions.includes("retry") ? (
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 2}
                        onClick={() =>
                          void run(() =>
                            api.action(flow, { action: "retry", reason }),
                          )
                        }
                      >
                        核对后恢复执行
                      </button>
                    ) : null}
                    {flow.allowedActions.includes("request_recovery") ? (
                      <button
                        type="button"
                        disabled={busy || reason.trim().length < 2}
                        onClick={() =>
                          void run(() =>
                            api.action(flow, {
                              action: "request_recovery",
                              reason,
                            }),
                          )
                        }
                      >
                        申请生产恢复
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}
              {flow.objections.length ? (
                <section className="lifecycle-card">
                  <h3>本轮异议</h3>
                  {flow.objections.map((o) => (
                    <div key={o.objectionKey}>
                      <p>
                        {o.actorName}：{o.reason}
                      </p>
                      {o.resolution ? (
                        <p>处理结论：{o.resolution}</p>
                      ) : flow.allowedActions.includes("resolve_objection") ? (
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 2}
                          onClick={() =>
                            void run(() =>
                              api.action(flow, {
                                action: "resolve_objection",
                                reason,
                                objectionKey: o.objectionKey,
                              }),
                            )
                          }
                        >
                          按填写结论处理异议
                        </button>
                      ) : (
                        <p>等待负责人处理。</p>
                      )}
                    </div>
                  ))}
                </section>
              ) : null}
              {flow.canReportBug ? (
                <form
                  className="lifecycle-card"
                  onSubmit={(e) => void report(e)}
                >
                  <h3>提交关联 Bug</h3>
                  <label>
                    问题名称
                    <input
                      required
                      minLength={2}
                      maxLength={500}
                      value={bugTitle}
                      onChange={(e) => setBugTitle(e.target.value)}
                    />
                  </label>
                  <label>
                    复现步骤与预期结果
                    <textarea
                      required
                      minLength={2}
                      maxLength={10_000}
                      rows={3}
                      value={bugDescription}
                      onChange={(e) => setBugDescription(e.target.value)}
                    />
                  </label>
                  <label>
                    影响程度
                    <select
                      value={severity}
                      onChange={(e) =>
                        setSeverity(e.target.value as typeof severity)
                      }
                    >
                      <option value="critical">严重：业务不可用</option>
                      <option value="major">主要：功能受影响</option>
                      <option value="minor">次要：局部问题</option>
                    </select>
                  </label>
                  <button disabled={busy}>提交 Bug</button>
                </form>
              ) : null}
              {bugs.length ? (
                <section className="lifecycle-card">
                  <h3>关联 Bug</h3>
                  {bugs.map((bug) => (
                    <article key={bug.bugKey}>
                      <h4>{bug.title}</h4>
                      <p>{bug.description}</p>
                      <p>
                        {bug.status === "open"
                          ? "待安排修复"
                          : bug.status === "repairing"
                            ? "修复处理中"
                            : "修复已验收"}
                      </p>
                      {bug.status === "open" &&
                      context?.roles.some((r) =>
                        ["product_owner", "developer"].includes(r),
                      ) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              api.repairBug(bug.bugKey, "start_repair"),
                            )
                          }
                        >
                          创建修复需求
                        </button>
                      ) : null}
                      {bug.repairWorkflowKey ? (
                        <button
                          type="button"
                          onClick={() => setSelected(bug.repairWorkflowKey)}
                        >
                          查看修复交付
                        </button>
                      ) : null}
                      {bug.status === "repairing" &&
                      context?.roles.some((r) =>
                        ["tester", "requester"].includes(r),
                      ) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() => api.repairBug(bug.bugKey, "resolve"))
                          }
                        >
                          确认修复完成
                        </button>
                      ) : null}
                    </article>
                  ))}
                </section>
              ) : null}
              <section className="lifecycle-card">
                <h3>交付记录</h3>
                <ol className="lifecycle-history">
                  {flow.events
                    .slice()
                    .reverse()
                    .map((event, i) => (
                      <li key={i}>
                        <strong>{event.title}</strong>
                        <span>{event.detail}</span>
                        <time>
                          {new Date(event.at).toLocaleString("zh-CN")}
                        </time>
                      </li>
                    ))}
                </ol>
              </section>
            </>
          ) : (
            <div className="lifecycle-card">
              <p>选择一项交付，查看方案、审核意见和执行结果。</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
