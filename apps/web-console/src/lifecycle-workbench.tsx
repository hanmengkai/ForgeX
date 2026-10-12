import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FormEvent,
} from "react";
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
import { LifecycleConfirmation } from "./lifecycle-confirmation.js";
import {
  lifecyclePhases,
  lifecycleNextStep,
  needsLifecycleAction,
  reviewArtifactKind,
  lifecycleActionLabel,
} from "./lifecycle-presentation.js";

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

export function LifecycleWorkbench({
  client,
  mode = "delivery",
}: {
  client: ForgeXClient;
  mode?: "delivery" | "approvals";
}) {
  const api = client.lifecycle;
  const [context, setContext] = useState<LifecycleContext | null>(null),
    [items, setItems] = useState<LifecycleView[]>([]),
    [selected, setSelected] = useState<string | null>(() => {
      const key = new URLSearchParams(window.location.search).get("workflow");
      return key && /^[a-f0-9-]{36}$/iu.test(key) ? key : null;
    }),
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
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState(mode === "approvals" ? "mine" : "all"),
    [creating, setCreating] = useState(
      () => new URLSearchParams(window.location.search).get("create") === "1",
    ),
    [tab, setTab] = useState("current");
  const [mobileList, setMobileList] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    flow: LifecycleView;
    role: LifecycleRole;
    decision: "approve" | "reject" | "object";
    reason: string;
    rework?:
      | "requirements"
      | "design"
      | "implementation"
      | "verification"
      | "deployment";
  } | null>(null);
  const cancelConfirmation = useCallback(() => setConfirmation(null), []);
  const draftTarget = useRef<{ key: string; version: number } | null>(null);
  useEffect(() => {
    if (
      !busy &&
      flow &&
      ((confirmation &&
        (confirmation.flow.workflowKey !== flow.workflowKey ||
          confirmation.flow.version !== flow.version)) ||
        (reason &&
          draftTarget.current &&
          (draftTarget.current.key !== flow.workflowKey ||
            draftTarget.current.version !== flow.version)))
    ) {
      setConfirmation(null);
      setReason("");
      draftTarget.current = null;
      setError("交付内容已更新，请重新核对当前版本后审核");
    }
  }, [flow, confirmation, busy, reason]);
  useEffect(() => {
    if (selected) {
      const url = new URL(window.location.href);
      url.searchParams.set("workflow", selected);
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + url.search,
      );
    }
  }, [selected]);
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
    const key =
      selectedRef.current ??
      (mode === "approvals"
        ? nextItems.find(needsLifecycleAction)
        : nextItems[0]
      )?.workflowKey ??
      null;
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
      setCreating(false);
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
    setConfirmation({
      flow: structuredClone(flow),
      role: activeRole as LifecycleRole,
      decision,
      reason,
      ...(decision === "reject" && selectedRework
        ? { rework: selectedRework }
        : {}),
    });
  };
  const confirmDecision = () => {
    if (!api || !flow || !confirmation) return;
    if (
      flow.workflowKey !== confirmation.flow.workflowKey ||
      flow.version !== confirmation.flow.version
    ) {
      setConfirmation(null);
      setError("交付内容已更新，请重新核对当前版本后审核");
      return;
    }
    const { flow: target, ...command } = confirmation;
    void run(() => api.decide(target, command)).then((ok) => {
      setConfirmation(null);
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
  const visible = items.filter(
    (item) =>
      (!query.trim() || `${item.title} ${item.brief}`.includes(query.trim())) &&
      (filter === "all" ||
        (filter === "mine" && needsLifecycleAction(item)) ||
        (filter === "blocked" && !!item.blockedReason) ||
        (filter === "closed" && item.stage === "closed") ||
        (filter === "active" && item.stage !== "closed")),
  );
  const phaseIndex = flow
    ? lifecyclePhases.findIndex((p) => p.stages.includes(flow.stage))
    : 0;
  const materialKind = flow ? reviewArtifactKind(flow.stage) : "requirements";
  const reviewMaterials =
    flow?.artifacts.filter((a) => a.kind === materialKind) ?? [];
  return (
    <div
      className={`lifecycle-workbench ${flow && !mobileList ? "delivery-selected" : ""}`}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">ForgeX 2.0</span>
          <h1>{mode === "approvals" ? "我的审批" : "交付需求"}</h1>
          <p>把业务想法交给 AI，在关键环节审核，让每一次交付都有据可查。</p>
        </div>
        <div className="delivery-header-actions">
          <button
            className="button secondary delivery-mobile-back"
            type="button"
            onClick={() => setMobileList((v) => !v)}
          >
            {mobileList ? "查看选中交付" : "查看交付列表"}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            刷新进度
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="lifecycle-error">
          {error}
        </p>
      ) : null}
      <div className="delivery-list-toolbar">
        <label className="delivery-search">
          搜索交付需求
          <input
            type="search"
            aria-label="搜索交付需求"
            placeholder="搜索名称或业务目标"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="delivery-filters" aria-label="交付筛选">
          {[
            ["all", "全部"],
            ["mine", "待我处理"],
            ["active", "进行中"],
            ["blocked", "阻塞"],
            ["closed", "已关闭"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value!)}
            >
              {label}
              <span>
                {
                  items.filter(
                    (item) =>
                      value === "all" ||
                      (value === "mine" && needsLifecycleAction(item)) ||
                      (value === "active" && item.stage !== "closed") ||
                      (value === "blocked" && item.blockedReason) ||
                      (value === "closed" && item.stage === "closed"),
                  ).length
                }
              </span>
            </button>
          ))}
        </div>
      </div>
      <div
        className={`lifecycle-grid ${mobileList || !flow ? "show-list" : "show-detail"}`}
      >
        <aside className="lifecycle-list">
          {context?.roles.some((r) =>
            ["requester", "product_owner", "requirement_analyst"].includes(r),
          ) ? (
            <>
              <button
                className="button primary delivery-create-button"
                type="button"
                aria-expanded={creating}
                onClick={() => setCreating((v) => !v)}
              >
                ＋ 提出需求
              </button>
              {creating || (!items.length && !flow) ? (
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
                      placeholder="例如：让访客在线预约，提交后可以查询，重复点击不要产生多条预约。"
                      value={brief}
                      onChange={(e) => setBrief(e.target.value)}
                    />
                  </label>
                  <button disabled={busy || !context} type="submit">
                    提交给需求 AI
                  </button>
                </form>
              ) : null}
            </>
          ) : null}
          <section
            className="lifecycle-card delivery-list-panel"
            aria-label="交付列表"
          >
            <h2>
              交付列表 <small>{visible.length} 项</small>
            </h2>
            {loading ? (
              <p>正在读取交付…</p>
            ) : !visible.length ? (
              <div className="delivery-empty">
                <strong>
                  {items.length ? "没有符合条件的交付" : "从一个业务目标开始"}
                </strong>
                <p>
                  {items.length
                    ? "调整搜索或筛选条件后继续查看。"
                    : "提交需求后，AI 会整理方案，等待你和产品确认。"}
                </p>
              </div>
            ) : (
              visible.map((item) => (
                <button
                  className={`lifecycle-item ${item.workflowKey === selected ? "selected" : ""}`}
                  key={item.workflowKey}
                  type="button"
                  onClick={() => {
                    setTab("current");
                    setConfirmation(null);
                    setFlow(null);
                    setError(null);
                    setReason("");
                    setMobileList(false);
                    setRole("");
                    setRework("");
                    setSelected(item.workflowKey);
                  }}
                >
                  <strong>{item.title}</strong>
                  <small>{item.brief.slice(0, 60)}</small>
                  <span
                    className={`delivery-state ${item.blockedReason ? "blocked" : item.stage === "closed" ? "closed" : needsLifecycleAction(item) ? "review" : "running"}`}
                  >
                    {item.blockedReason ? "执行阻塞" : item.stageLabel}
                  </span>
                  <small>
                    {needsLifecycleAction(item) ? "需要你处理" : ""} ·{" "}
                    {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                  </small>
                </button>
              ))
            )}
          </section>
          <details className="lifecycle-card delivery-notifications">
            <summary>
              我的通知{" "}
              <span>{notifications.filter((n) => !n.read).length} 条未读</span>
            </summary>
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
          </details>
        </aside>
        <section className="lifecycle-detail" aria-label="交付详情">
          {flow ? (
            <>
              <div className="lifecycle-card delivery-detail-hero">
                <div className="delivery-detail-heading">
                  <span className="eyebrow">
                    {needsLifecycleAction(flow) ? "需要你的处理" : "当前交付"}
                  </span>
                  <span
                    className={`delivery-state ${flow.blockedReason ? "blocked" : flow.stage === "closed" ? "closed" : "review"}`}
                  >
                    {flow.blockedReason ? "执行阻塞" : flow.stageLabel}
                  </span>
                </div>
                <h2>{flow.title}</h2>
                <p>{flow.brief}</p>
                <p>
                  需求第 {flow.requirementVersion} 版 · 设计第{" "}
                  {flow.designVersion} 版
                </p>
                {flow.sourceBugKey ? <p>这是关联缺陷的修复需求。</p> : null}
                <p className="delivery-next-step">
                  下一步：{lifecycleNextStep(flow)}
                </p>
                <ol className="lifecycle-stages" aria-label="交付阶段">
                  {lifecyclePhases.map((phase, index) => (
                    <li
                      key={phase.label}
                      className={
                        index === phaseIndex
                          ? flow.stage === "closed"
                            ? "active completed"
                            : "active"
                          : index < phaseIndex
                            ? "done"
                            : "pending"
                      }
                      aria-current={index === phaseIndex ? "step" : undefined}
                    >
                      <span>
                        {index < phaseIndex
                          ? "✓"
                          : String(index + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <strong>{phase.label}</strong>
                        <small>
                          {index === phaseIndex
                            ? flow.stageLabel
                            : index < phaseIndex
                              ? "已走过该阶段"
                              : "等待前序完成"}
                        </small>
                      </div>
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
                {[
                  "release_approval",
                  "online_acceptance",
                  "recovery_approval",
                ].includes(flow.stage) ? (
                  <div
                    className="delivery-joint-approvals"
                    aria-label="三方确认状态"
                  >
                    {(
                      [
                        "developer",
                        "production_ops",
                        "requester",
                      ] as LifecycleRole[]
                    ).map((r) => {
                      const approval = flow.approvals.find((a) => a.role === r);
                      return (
                        <div
                          key={r}
                          className={approval ? "approved" : "waiting"}
                        >
                          <strong>{roles[r]}</strong>
                          <span>
                            {approval
                              ? `${approval.actorName} · 已确认`
                              : "等待确认"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              {flow.allowedRoles.length || flow.allowedActions.length ? (
                <section
                  className="lifecycle-card delivery-approval"
                  aria-label="当前审核"
                >
                  <span className="eyebrow">
                    {flow.stage === "design_review"
                      ? "独立设计审核"
                      : "当前审批"}
                  </span>
                  <h3>当前需要我的处理</h3>
                  <p className="delivery-review-target">{flow.title}</p>
                  <p>
                    审核对象：{flow.stageLabel}
                    <br />
                    需求第 {flow.requirementVersion} 版 · 设计第{" "}
                    {flow.designVersion} 版
                  </p>
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
                      onChange={(e) => {
                        draftTarget.current = {
                          key: flow.workflowKey,
                          version: flow.version,
                        };
                        setReason(e.target.value);
                      }}
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
                          className="button primary"
                          onClick={() => decide("approve")}
                        >
                          审核通过
                        </button>
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 2}
                          className="button secondary"
                          onClick={() => decide("object")}
                        >
                          提出异议
                        </button>
                        <button
                          type="button"
                          disabled={busy || reason.trim().length < 2}
                          className="button danger-outline"
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
              ) : (
                <section
                  className="lifecycle-card delivery-approval"
                  aria-label="等待处理"
                >
                  <span className="eyebrow">下一步</span>
                  <h3>
                    {flow.stage === "closed"
                      ? "交付已关闭"
                      : "等待对应岗位处理"}
                  </h3>
                  <p>{lifecycleNextStep(flow)}</p>
                  <p className="delivery-quiet">
                    你可以查看成果与记录；当前无需你批准。
                  </p>
                </section>
              )}
              <div
                className="delivery-materials"
                role="region"
                aria-label="当前审核材料"
              >
                <div
                  className="delivery-detail-tabs"
                  role="tablist"
                  aria-label="交付内容"
                >
                  {[
                    ["current", "当前材料"],
                    ["all", "全部成果"],
                    ["activity", "审批与记录"],
                    ["bugs", "关联 Bug"],
                  ].map(([value, label], i) => (
                    <button
                      id={`delivery-tab-${value}`}
                      type="button"
                      role="tab"
                      aria-selected={tab === value}
                      aria-controls="delivery-material-panel"
                      tabIndex={tab === value ? 0 : -1}
                      key={value}
                      onClick={() => setTab(value!)}
                      onKeyDown={(e) => {
                        const values = ["current", "all", "activity", "bugs"];
                        let nextIndex =
                          e.key === "ArrowRight"
                            ? (i + 1) % 4
                            : e.key === "ArrowLeft"
                              ? (i + 3) % 4
                              : e.key === "Home"
                                ? 0
                                : e.key === "End"
                                  ? 3
                                  : -1;
                        if (nextIndex >= 0) {
                          e.preventDefault();
                          setTab(values[nextIndex]!);
                          document
                            .getElementById(`delivery-tab-${values[nextIndex]}`)
                            ?.focus();
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div
                  id="delivery-material-panel"
                  role="tabpanel"
                  aria-labelledby={`delivery-tab-${tab}`}
                >
                  {(tab === "current"
                    ? reviewMaterials
                    : tab === "all"
                      ? flow.artifacts
                      : []
                  ).map((artifact, index) => (
                    <article
                      key={`${artifact.kind}-${index}`}
                      className="lifecycle-card"
                    >
                      <h3>{artifactLabels[artifact.kind]}</h3>
                      <p>{artifact.summary}</p>
                      {artifact.document ? (
                        <div className="lifecycle-content">
                          {artifact.document.changes ? (
                            <details className="delivery-changes" open>
                              <summary>相较上一份方案的变化</summary>
                              {artifact.document.changes.added.map(
                                (text, i) => (
                                  <p className="change-added" key={`a${i}`}>
                                    ＋ {text}
                                  </p>
                                ),
                              )}
                              {artifact.document.changes.removed.map(
                                (text, i) => (
                                  <p className="change-removed" key={`r${i}`}>
                                    − {text}
                                  </p>
                                ),
                              )}
                              {artifact.document.changes.reordered ? (
                                <p>条目顺序已调整，请重新核对方案。</p>
                              ) : null}
                              {!artifact.document.changes.added.length &&
                              !artifact.document.changes.removed.length &&
                              !artifact.document.changes.reordered ? (
                                <p>正文与上一份一致；请继续核对审批意见。</p>
                              ) : null}
                            </details>
                          ) : null}
                          {artifact.document.sections.map((section) => (
                            <section key={section.title}>
                              <h4>{section.title}</h4>
                              {section.paragraphs.map((text, i) => (
                                <p key={i}>{text}</p>
                              ))}
                              {section.items.length ? (
                                <ul>
                                  {section.items.map((text, i) => (
                                    <li key={i}>{text}</li>
                                  ))}
                                </ul>
                              ) : !section.paragraphs.length ? (
                                <p className="delivery-quiet">
                                  当前方案未提出相关条目。
                                </p>
                              ) : null}
                            </section>
                          ))}
                        </div>
                      ) : null}
                      {artifact.content ? (
                        artifact.document ? null : (
                          <LifecycleDocument content={artifact.content} />
                        )
                      ) : null}
                      {artifact.url ? (
                        <a
                          className="primary-button"
                          href={artifact.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开
                          {artifact.summary.includes("生产") ? "线上" : "测试"}
                          环境
                        </a>
                      ) : null}
                      {artifact.checks.length ? (
                        <ul>
                          {artifact.checks.map((check, i) => (
                            <li key={i}>
                              {check.passed ? "已通过" : "未通过"}：
                              {check.title}
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
                                {key === "commitSha" ? "代码提交" : "制品摘要"}
                                ：{value}
                              </p>
                            ),
                          )}
                        </details>
                      ) : null}
                    </article>
                  ))}

                  {tab === "current" && !reviewMaterials.length ? (
                    <div className="lifecycle-card delivery-empty">
                      <h3>
                        {flow.stage === "closed"
                          ? "交付已完成"
                          : "材料正在准备"}
                      </h3>
                      <p>
                        {flow.stage === "closed"
                          ? "查看全部成果或提交关联 Bug，继续追踪交付质量。"
                          : lifecycleNextStep(flow)}
                      </p>
                    </div>
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
                          ) : flow.allowedActions.includes(
                              "resolve_objection",
                            ) ? (
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
                  {tab === "bugs" && flow.canReportBug ? (
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
                  {tab === "bugs" && bugs.length ? (
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
                                void run(() =>
                                  api.repairBug(bug.bugKey, "resolve"),
                                )
                              }
                            >
                              确认修复完成
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </section>
                  ) : null}
                  {tab === "activity" ? (
                    <section className="lifecycle-card">
                      <h3>交付记录</h3>
                      <details>
                        <summary>技术详情</summary>
                        <p>交付标识：{flow.workflowKey}</p>
                        <p>记录版本：{flow.version}</p>
                      </details>
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
                  ) : null}
                  {tab === "bugs" && !bugs.length ? (
                    <p className="delivery-quiet">暂时没有关联 Bug。</p>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="lifecycle-card">
              <p>选择一项交付，查看方案、审核意见和执行结果。</p>
            </div>
          )}
        </section>
      </div>
      {confirmation ? (
        <LifecycleConfirmation
          {...confirmation}
          busy={busy}
          onCancel={cancelConfirmation}
          onConfirm={confirmDecision}
        />
      ) : null}
    </div>
  );
}

function LifecycleDocument({ content }: { content: string }) {
  return (
    <div className="lifecycle-content">
      {content
        .split(/\n\n/)
        .filter(Boolean)
        .map((block, index) => {
          const lines = block.split("\n");
          const first = lines[0] ?? "";
          const heading = first.endsWith("：") && first.length < 40;
          return (
            <section key={index}>
              {heading ? <h4>{first.slice(0, -1)}</h4> : null}
              {lines.slice(heading ? 1 : 0).map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </section>
          );
        })}
    </div>
  );
}
