import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  ForgeXClient,
  RequirementActionLinks,
  RequirementDetail,
  RequirementListItem,
  RequirementSpecInput,
} from "./api.js";
import { CreateRequirementDialog } from "./create-requirement-dialog.js";
import { ExtensionCenter } from "./extension-center.js";
import { ArrowIcon, CheckIcon, PlusIcon, SparkIcon } from "./icons.js";
import { McpInvocationCenter } from "./mcp-invocation-center.js";
import { SkillSelectionDialog } from "./skill-selection-dialog.js";
import { WorkerCenter } from "./worker-center.js";

interface RequirementWorkbenchProps {
  client: ForgeXClient;
  projectName?: string;
  actorName?: string;
  onSignOut?: () => Promise<void>;
  signingOut?: boolean;
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

const formatVerifiedAt = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const statusTone = (status: RequirementListItem["status"]) => {
  if (status === "已完成") return "success";
  if (status === "AI 正在实现") return "running";
  if (status === "验证失败，版本已封存") return "attention";
  if (status.includes("等待") || status.includes("确认")) return "attention";
  return "neutral";
};

const nonEmptyLines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

const priorityLabel = {
  must: "必须完成",
  should: "应该完成",
  could: "可以完成",
} as const;

function RequirementRevisionEditor({
  detail,
  actionUrl,
  busy,
  onSave,
}: {
  detail: RequirementDetail;
  actionUrl: string;
  busy: boolean;
  onSave(
    actionUrl: string,
    spec: RequirementSpecInput,
    expectedRevision: number,
    selfUrl: string,
  ): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(detail.spec.title);
  const [goal, setGoal] = useState(detail.spec.goal);
  const [stories, setStories] = useState(() =>
    structuredClone(detail.spec.userStories),
  );
  const [acceptance, setAcceptance] = useState(() =>
    structuredClone(detail.spec.acceptanceCriteria),
  );
  const [questions, setQuestions] = useState(() =>
    structuredClone(detail.spec.openQuestions),
  );
  const [error, setError] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (editing) {
      wasEditingRef.current = true;
      titleRef.current?.focus();
    } else if (wasEditingRef.current) {
      wasEditingRef.current = false;
      openerRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    setTitle(detail.spec.title);
    setGoal(detail.spec.goal);
    setStories(structuredClone(detail.spec.userStories));
    setAcceptance(structuredClone(detail.spec.acceptanceCriteria));
    setQuestions(structuredClone(detail.spec.openQuestions));
  }, [detail.version, detail.spec, editing]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const userStories = stories.map((story) => ({
      role: story.role.trim(),
      need: story.need.trim(),
      value: story.value.trim(),
    }));
    const criteria = acceptance.map((criterion) => ({
      title: criterion.title.trim(),
      description: criterion.description.trim(),
      priority: criterion.priority,
    }));
    if (
      title.trim().length < 2 ||
      goal.trim().length < 4 ||
      criteria.length === 0 ||
      criteria.some(
        (criterion) =>
          criterion.title.length < 2 || criterion.description.length < 4,
      ) ||
      questions.some((question) => question.trim().length < 2) ||
      userStories.some(
        (story) =>
          story.role.length < 2 ||
          story.need.length < 2 ||
          story.value.length < 2,
      )
    ) {
      setError("请完整填写业务目标、用户故事和至少一条完成标准");
      return;
    }
    setError(null);
    const currentRevision = detail.revisions.find(
      (revision) => revision.current,
    );
    if (!currentRevision) {
      setError("当前版本信息不完整，请刷新后重试");
      return;
    }
    const saved = await onSave(
      actionUrl,
      {
        schemaVersion: 1,
        title: title.trim(),
        goal: goal.trim(),
        userStories,
        acceptanceCriteria: criteria,
        openQuestions: questions.map((question) => question.trim()),
      },
      currentRevision.revision,
      detail.links.self,
    );
    if (saved) setEditing(false);
  };

  if (!editing) {
    return (
      <button
        ref={openerRef}
        className="text-action revision-edit-action"
        type="button"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        修订需求
      </button>
    );
  }

  return (
    <form className="revision-editor" onSubmit={submit}>
      <div className="field">
        <label htmlFor="revision-title">需求名称</label>
        <input
          ref={titleRef}
          id="revision-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="field">
        <label htmlFor="revision-goal">希望解决什么问题？</label>
        <textarea
          id="revision-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          disabled={busy}
        />
      </div>
      <fieldset className="structured-editor-list">
        <legend>谁会使用？</legend>
        {stories.map((story, index) => (
          <div className="structured-editor-item" key={index}>
            <div className="field">
              <label htmlFor={`revision-story-role-${index}`}>
                用户故事 {index + 1}：角色
              </label>
              <input
                id={`revision-story-role-${index}`}
                value={story.role}
                onChange={(event) =>
                  setStories((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, role: event.target.value }
                        : item,
                    ),
                  )
                }
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor={`revision-story-need-${index}`}>
                用户故事 {index + 1}：需要
              </label>
              <input
                id={`revision-story-need-${index}`}
                value={story.need}
                onChange={(event) =>
                  setStories((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, need: event.target.value }
                        : item,
                    ),
                  )
                }
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor={`revision-story-value-${index}`}>
                用户故事 {index + 1}：价值
              </label>
              <input
                id={`revision-story-value-${index}`}
                value={story.value}
                onChange={(event) =>
                  setStories((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, value: event.target.value }
                        : item,
                    ),
                  )
                }
                disabled={busy}
              />
            </div>
            <button
              className="text-action"
              type="button"
              disabled={busy}
              onClick={() =>
                setStories((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              删除这条用户故事
            </button>
          </div>
        ))}
        <button
          className="text-action"
          type="button"
          disabled={busy}
          onClick={() =>
            setStories((current) => [
              ...current,
              { role: "", need: "", value: "" },
            ])
          }
        >
          添加用户故事
        </button>
      </fieldset>
      <fieldset className="structured-editor-list">
        <legend>怎么才算完成？</legend>
        {acceptance.map((criterion, index) => (
          <div className="structured-editor-item" key={index}>
            <div className="field">
              <label htmlFor={`revision-criterion-title-${index}`}>
                完成标准 {index + 1}：名称
              </label>
              <input
                id={`revision-criterion-title-${index}`}
                value={criterion.title}
                onChange={(event) =>
                  setAcceptance((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, title: event.target.value }
                        : item,
                    ),
                  )
                }
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor={`revision-criterion-description-${index}`}>
                完成标准 {index + 1}：验收说明
              </label>
              <textarea
                id={`revision-criterion-description-${index}`}
                value={criterion.description}
                onChange={(event) =>
                  setAcceptance((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, description: event.target.value }
                        : item,
                    ),
                  )
                }
                rows={2}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor={`revision-criterion-priority-${index}`}>
                完成标准 {index + 1}：优先级
              </label>
              <select
                id={`revision-criterion-priority-${index}`}
                value={criterion.priority}
                onChange={(event) =>
                  setAcceptance((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? {
                            ...item,
                            priority: event.target.value as
                              "must" | "should" | "could",
                          }
                        : item,
                    ),
                  )
                }
                disabled={busy}
              >
                <option value="must">必须完成</option>
                <option value="should">应该完成</option>
                <option value="could">可以完成</option>
              </select>
            </div>
            <button
              className="text-action"
              type="button"
              disabled={busy}
              onClick={() =>
                setAcceptance((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              删除这条完成标准
            </button>
          </div>
        ))}
        <button
          className="text-action"
          type="button"
          disabled={busy}
          onClick={() =>
            setAcceptance((current) => [
              ...current,
              { title: "", description: "", priority: "must" },
            ])
          }
        >
          添加完成标准
        </button>
      </fieldset>
      <fieldset className="structured-editor-list">
        <legend>还有哪些问题需要澄清？</legend>
        {questions.map((question, index) => (
          <div className="structured-editor-item" key={index}>
            <div className="field">
              <label htmlFor={`revision-question-${index}`}>
                待澄清问题 {index + 1}
              </label>
              <textarea
                id={`revision-question-${index}`}
                value={question}
                onChange={(event) =>
                  setQuestions((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? event.target.value : item,
                    ),
                  )
                }
                rows={2}
                disabled={busy}
              />
            </div>
            <button
              className="text-action"
              type="button"
              disabled={busy}
              onClick={() =>
                setQuestions((current) =>
                  current.filter((_, itemIndex) => itemIndex !== index),
                )
              }
            >
              删除这个问题
            </button>
          </div>
        ))}
        <button
          className="text-action"
          type="button"
          disabled={busy}
          onClick={() => setQuestions((current) => [...current, ""])}
        >
          添加待澄清问题
        </button>
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="inline-form-actions">
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          取消修订
        </button>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? "正在保存…" : "保存新版本"}
        </button>
      </div>
    </form>
  );
}

function RequirementCard({
  item,
  busyAction,
  actionsBusy,
  detail,
  detailError,
  detailLoading,
  expanded,
  onAction,
  onRevise,
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
  onRevise(
    actionUrl: string,
    spec: RequirementSpecInput,
    expectedRevision: number,
    selfUrl: string,
  ): Promise<boolean>;
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
              {detail.spec.userStories.length > 0 ? (
                <div>
                  <span className="detail-label">用户故事</span>
                  <ul>
                    {detail.spec.userStories.map((story) => (
                      <li key={`${story.role}:${story.need}:${story.value}`}>
                        <strong>{story.role}</strong>
                        <span>
                          希望 {story.need}，从而 {story.value}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {detail.spec.openQuestions.length > 0 ? (
                <div>
                  <span className="detail-label">待澄清问题</span>
                  <ul>
                    {detail.spec.openQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="revision-history">
                <span className="detail-label">版本记录</span>
                <ol>
                  {detail.revisions.map((revision) => (
                    <li key={revision.version}>
                      <strong>{revision.version}</strong>
                      <span>{revision.changedBy}</span>
                      <small>{revision.changes.join("、")}</small>
                      {revision.contentState === "仅保留摘要" ? (
                        <small>旧版仅保留摘要</small>
                      ) : (
                        <details className="revision-spec-detail">
                          <summary>查看该版完整规格</summary>
                          <p>
                            <strong>需求名称：</strong>
                            {revision.spec.title}
                          </p>
                          <p>
                            <strong>业务目标：</strong>
                            {revision.spec.goal}
                          </p>
                          {revision.spec.userStories.length > 0 ? (
                            <ul>
                              {revision.spec.userStories.map((story) => (
                                <li
                                  key={`${story.role}:${story.need}:${story.value}`}
                                >
                                  {story.role}：{story.need}，从而 {story.value}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <ul>
                            {revision.spec.acceptanceCriteria.map(
                              (criterion) => (
                                <li
                                  key={`${criterion.title}:${criterion.description}`}
                                >
                                  {criterion.title}：{criterion.description}（
                                  {priorityLabel[criterion.priority]}）
                                </li>
                              ),
                            )}
                          </ul>
                          {revision.spec.openQuestions.length > 0 ? (
                            <p>
                              <strong>待澄清：</strong>
                              {revision.spec.openQuestions.join("；")}
                            </p>
                          ) : null}
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
              {detail.links.actions.revise ? (
                <RequirementRevisionEditor
                  detail={detail}
                  actionUrl={detail.links.actions.revise}
                  busy={actionsBusy}
                  onSave={onRevise}
                />
              ) : null}
              {detail.acceptance ? (
                <div className="acceptance-evidence">
                  <div className="acceptance-heading">
                    <span>
                      <CheckIcon /> 独立验证已通过
                    </span>
                    <small>
                      {detail.acceptance.verifiedBy} ·{" "}
                      {formatVerifiedAt(detail.acceptance.verifiedAt)}
                    </small>
                  </div>
                  <ul>
                    {detail.acceptance.checks.map((check, index) => (
                      <li key={`${check.title}:${index}`}>
                        <CheckIcon />
                        <span>{check.title}</span>
                        <strong>{check.status}</strong>
                      </li>
                    ))}
                  </ul>
                  {detail.links.preview ? (
                    <a
                      className="button preview-action"
                      href={detail.links.preview}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      打开效果预览
                      <ArrowIcon />
                    </a>
                  ) : null}
                  {item.links.actions.accept ? (
                    <button
                      className="button acceptance-action"
                      type="button"
                      disabled={actionsBusy}
                      onClick={() => onAction(item.links.actions.accept!, {})}
                    >
                      {busyAction === item.links.actions.accept
                        ? "正在记录验收…"
                        : "确认验收通过"}
                    </button>
                  ) : null}
                </div>
              ) : null}
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
  actorName,
  onSignOut,
  signingOut = false,
}: RequirementWorkbenchProps) {
  const [items, setItems] = useState<RequirementListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeView, setActiveView] = useState<
    "workbench" | "workers" | "extensions" | "approvals"
  >("workbench");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pendingDelivery, setPendingDelivery] = useState<{
    actionUrl: string;
    body: Record<string, unknown>;
    skills: Awaited<
      ReturnType<ForgeXClient["listExtensions"]>
    >["teamCapabilities"];
  } | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequirementDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const expandedDetailRef = useRef<string | null>(null);
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
      expandedDetailRef.current = null;
    };
  }, [load]);

  const summary = useMemo(
    () => ({
      needsAction: items.filter(
        (item) =>
          Object.keys(item.links.actions).length > 0 ||
          item.status === "验证失败，版本已封存",
      ).length,
      running: items.filter((item) => item.status === "AI 正在实现").length,
      accepting: items.filter((item) => item.status === "等待产品验收").length,
      completed: items.filter((item) => item.status === "已完成").length,
    }),
    [items],
  );

  const executeAction = async (
    actionUrl: string,
    body: Record<string, unknown>,
  ): Promise<boolean> => {
    if (actionActiveRef.current) return false;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      await client.runRequirementAction(actionUrl, body);
      await load();
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "操作没有完成，请重试",
      );
      return false;
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const runAction = async (
    actionUrl: string,
    body: Record<string, unknown>,
  ) => {
    if (!actionUrl.endsWith("/start-delivery")) {
      await executeAction(actionUrl, body);
      return;
    }
    if (actionActiveRef.current) return;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      const extensions = await client.listExtensions();
      setPendingDelivery({
        actionUrl,
        body,
        skills: extensions.teamCapabilities.filter(
          (item) => item.status === "可使用",
        ),
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "暂时无法读取团队能力",
      );
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const reviseRequirement = async (
    actionUrl: string,
    spec: RequirementSpecInput,
    expectedRevision: number,
    selfUrl: string,
  ) => {
    if (actionActiveRef.current || expandedDetailRef.current !== selfUrl) {
      return false;
    }
    const detailGeneration = detailGenerationRef.current;
    actionActiveRef.current = true;
    setBusyAction(actionUrl);
    setError(null);
    try {
      try {
        await client.reviseRequirement(actionUrl, spec, expectedRevision);
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "需求修订没有完成，请重试",
        );
        return false;
      }

      await load();
      if (
        mountedRef.current &&
        expandedDetailRef.current === selfUrl &&
        detailGenerationRef.current === detailGeneration
      ) {
        try {
          const refreshed = await client.getRequirement(selfUrl);
          if (
            mountedRef.current &&
            expandedDetailRef.current === selfUrl &&
            detailGenerationRef.current === detailGeneration &&
            refreshed.links.self === selfUrl
          ) {
            setDetail(refreshed);
          }
        } catch {
          setError("新版本已保存，但详情刷新失败，请刷新页面查看最新内容");
        }
      }
      return true;
    } finally {
      actionActiveRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    }
  };

  const toggleDetail = async (selfUrl: string) => {
    if (expandedDetail === selfUrl) {
      detailGenerationRef.current += 1;
      expandedDetailRef.current = null;
      setExpandedDetail(null);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const generation = ++detailGenerationRef.current;
    expandedDetailRef.current = selfUrl;
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
          <button
            className={`nav-item ${activeView === "approvals" ? "active" : ""}`}
            type="button"
            aria-label="操作确认"
            aria-current={activeView === "approvals" ? "page" : undefined}
            onClick={() => setActiveView("approvals")}
          >
            <span>✓</span>操作确认
          </button>
          <button
            className={`nav-item ${activeView === "extensions" ? "active" : ""}`}
            type="button"
            aria-label="扩展中心"
            aria-current={activeView === "extensions" ? "page" : undefined}
            onClick={() => setActiveView("extensions")}
          >
            <span>◇</span>扩展中心
          </button>
        </nav>
        {actorName && onSignOut ? (
          <div className="session-profile">
            <span>
              <small>当前用户</small>
              <strong>{actorName}</strong>
            </span>
            <button
              type="button"
              disabled={signingOut}
              onClick={() => void onSignOut()}
            >
              {signingOut ? "正在退出…" : "退出登录"}
            </button>
          </div>
        ) : null}
        <div className="sidebar-note">
          <CheckIcon />
          <span>
            <strong>交付边界已保护</strong>
            <small>生产操作仍需人工审批</small>
          </span>
        </div>
      </aside>

      <main className="workspace" id={activeView}>
        {activeView === "approvals" ? (
          <McpInvocationCenter client={client} />
        ) : activeView === "extensions" ? (
          <ExtensionCenter client={client} />
        ) : activeView === "workers" ? (
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
                      onRevise={reviseRequirement}
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
      {pendingDelivery ? (
        <SkillSelectionDialog
          skills={pendingDelivery.skills}
          busy={busyAction === pendingDelivery.actionUrl}
          onClose={() => setPendingDelivery(null)}
          onConfirm={(skillKeys) =>
            executeAction(pendingDelivery.actionUrl, {
              ...pendingDelivery.body,
              skillKeys,
            })
          }
        />
      ) : null}
    </div>
  );
}
