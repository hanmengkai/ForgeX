import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import type {
  ForgeXClient,
  PlatformCustomerItem,
  ProjectInitializationView,
  PlatformProjectItem,
  PlatformRepositoryItem,
} from "./api.js";
import { createBrowserUuid } from "./browser-uuid.js";

interface PlatformConfigurationCenterProps {
  client: ForgeXClient;
}

type ResourceEditor =
  | { kind: "customer"; mode: "create"; name: string; summary: string }
  | {
      kind: "customer";
      mode: "edit";
      item: PlatformCustomerItem;
      name: string;
      summary: string;
      enabled: boolean;
    }
  | {
      kind: "project";
      mode: "create";
      customer: PlatformCustomerItem;
      name: string;
      summary: string;
    }
  | {
      kind: "project";
      mode: "edit";
      item: PlatformProjectItem;
      name: string;
      summary: string;
      enabled: boolean;
    }
  | {
      kind: "repository";
      mode: "create";
      project: PlatformProjectItem;
      name: string;
      gitUrl: string;
      localPath: string;
      defaultBranch: string;
    }
  | {
      kind: "repository";
      mode: "edit";
      item: PlatformRepositoryItem;
      name: string;
      gitUrl: string;
      localPath: string;
      defaultBranch: string;
      enabled: boolean;
    };

const createCustomerEditor = (): ResourceEditor => ({
  kind: "customer",
  mode: "create",
  name: "",
  summary: "",
});

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const useModalKeyboard = (
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  canClose: boolean,
  onClose: () => void,
) => {
  const canCloseRef = useRef(canClose);
  const onCloseRef = useRef(onClose);
  canCloseRef.current = canClose;
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>(focusableSelector);
    (focusable ?? dialog)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const candidates = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (candidates.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0]!;
      const last = candidates.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [dialogRef, open]);
};

function ProjectInitializationPanel({
  client,
  project,
}: {
  client: ForgeXClient;
  project: PlatformProjectItem;
}) {
  const [initialization, setInitialization] =
    useState<ProjectInitializationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getProjectInitialization(
        project.links.initialization,
      );
      if (mountedRef.current && generation === generationRef.current) {
        setInitialization(result);
      }
    } catch (caught) {
      if (mountedRef.current && generation === generationRef.current) {
        setError(
          caught instanceof Error ? caught.message : "暂时无法读取项目准备状态",
        );
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, [client, project.links.initialization]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, [load]);

  const initialize = async () => {
    if (applying) return;
    setApplying(true);
    setError(null);
    const generation = ++generationRef.current;
    try {
      const result = await client.initializeProject(
        project.links.actions.initialize,
        {
          presetKey: "standard-delivery",
          presetVersion: 1,
          requestKey: createBrowserUuid(),
        },
      );
      if (mountedRef.current && generation === generationRef.current) {
        setInitialization(result);
      }
    } catch (caught) {
      if (mountedRef.current && generation === generationRef.current) {
        setError(
          caught instanceof Error ? caught.message : "标准交付预设没有应用成功",
        );
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setApplying(false);
      }
    }
  };

  const pendingCount =
    initialization?.tasks.filter((task) => task.status === "action_required")
      .length ?? 0;
  const statusText =
    initialization?.status === "ready"
      ? "标准交付准备已完成"
      : initialization?.status === "action_required"
        ? `已应用，继续完成 ${pendingCount} 项准备`
        : "尚未应用标准交付预设";

  return (
    <section className="project-initialization-panel">
      <div className="project-initialization-heading">
        <div>
          <span className="eyebrow">DELIVERY PRESET</span>
          <h4>标准交付准备</h4>
          <p>{loading ? "正在检查项目准备状态…" : statusText}</p>
        </div>
        {initialization?.status === "not_started" ? (
          <button
            className="button primary compact-button"
            type="button"
            disabled={applying}
            onClick={() => void initialize()}
          >
            {applying ? "正在应用…" : "应用标准交付预设"}
          </button>
        ) : null}
      </div>
      {error ? (
        <div className="project-initialization-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}
      {initialization ? (
        <ul className="project-initialization-tasks">
          {initialization.tasks.map((task) => (
            <li key={task.key}>
              <span
                className={`status-dot ${
                  task.status === "ready" ? "ready" : "pending"
                }`}
                aria-hidden="true"
              />
              <div>
                <strong>{task.name}</strong>
                <p>{task.detail}</p>
              </div>
              <span className="project-initialization-task-status">
                {task.status === "ready" ? "已就绪" : "待完成"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="project-initialization-note">
        加载项目只检查状态；MCP 凭据始终保留在执行设备本地，不会由预设自动启用。
      </p>
    </section>
  );
}

export function PlatformConfigurationCenter({
  client,
}: PlatformConfigurationCenterProps) {
  const [customers, setCustomers] = useState<PlatformCustomerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<ResourceEditor | null>(null);
  const [query, setQuery] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [selectedProject, setSelectedProject] = useState<{
    customer: PlatformCustomerItem;
    project: PlatformProjectItem;
  } | null>(null);
  const generationRef = useRef(0);
  const editorDialogRef = useRef<HTMLElement>(null);
  const projectDetailDialogRef = useRef<HTMLElement>(null);

  useModalKeyboard(editor !== null, editorDialogRef, !saving, () =>
    setEditor(null),
  );
  useModalKeyboard(
    selectedProject !== null,
    projectDetailDialogRef,
    !saving,
    () => setSelectedProject(null),
  );

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const overview = await client.listPlatformConfiguration();
      if (generation === generationRef.current) {
        setCustomers(overview.customers);
      }
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "暂时无法读取客户与项目配置",
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

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editor.kind === "customer") {
        if (editor.mode === "create") {
          await client.createPlatformCustomer({
            name: editor.name.trim(),
            summary: editor.summary.trim(),
          });
        } else {
          await client.updatePlatformCustomer(
            editor.item.links.self,
            editor.item.revision,
            {
              name: editor.name.trim(),
              summary: editor.summary.trim(),
              enabled: editor.enabled,
            },
          );
        }
      } else if (editor.kind === "project") {
        if (editor.mode === "create") {
          await client.createPlatformProject(
            editor.customer.links.actions.createProject,
            { name: editor.name.trim(), summary: editor.summary.trim() },
          );
        } else {
          await client.updatePlatformProject(
            editor.item.links.self,
            editor.item.revision,
            {
              name: editor.name.trim(),
              summary: editor.summary.trim(),
              enabled: editor.enabled,
            },
          );
        }
      } else if (editor.mode === "create") {
        await client.createProjectRepository(
          editor.project.links.actions.createRepository,
          {
            name: editor.name.trim(),
            gitUrl: editor.gitUrl.trim(),
            localPath: editor.localPath.trim(),
            defaultBranch: editor.defaultBranch.trim(),
          },
        );
      } else {
        await client.updateProjectRepository(
          editor.item.links.self,
          editor.item.revision,
          {
            name: editor.name.trim(),
            gitUrl: editor.gitUrl.trim(),
            localPath: editor.localPath.trim(),
            defaultBranch: editor.defaultBranch.trim(),
            enabled: editor.enabled,
          },
        );
      }
      setEditor(null);
      setSelectedProject(null);
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "配置没有保存，请重试",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (!window.confirm(`确定删除“${label}”吗？`)) return;
    setSelectedProject(null);
    setSaving(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "删除没有完成，请重试",
      );
    } finally {
      setSaving(false);
    }
  };

  const editorTitle = editor
    ? `${editor.mode === "create" ? "新建" : "编辑"}${
        editor.kind === "customer"
          ? "客户"
          : editor.kind === "project"
            ? "项目"
            : "代码仓库"
      }`
    : "";

  const resourceRows = useMemo<
    Array<{
      customer: PlatformCustomerItem;
      project: PlatformProjectItem | null;
    }>
  >(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const rows: Array<{
      customer: PlatformCustomerItem;
      project: PlatformProjectItem | null;
    }> = [];
    for (const customer of customers) {
      if (customer.projects.length === 0) {
        rows.push({ customer, project: null });
      } else {
        rows.push(
          ...customer.projects.map((project) => ({ customer, project })),
        );
      }
    }
    return rows.filter(({ customer, project }) => {
      const enabled = customer.enabled && (project?.enabled ?? true);
      if (enabledFilter === "enabled" && !enabled) return false;
      if (enabledFilter === "disabled" && enabled) return false;
      if (!normalizedQuery) return true;
      return `${customer.name} ${customer.summary} ${project?.name ?? ""} ${
        project?.summary ?? ""
      }`
        .toLocaleLowerCase("zh-CN")
        .includes(normalizedQuery);
    });
  }, [customers, enabledFilter, query]);

  return (
    <div className="platform-configuration-center">
      <header className="topbar platform-configuration-topbar">
        <div>
          <span className="eyebrow">PLATFORM RESOURCES</span>
          <h1>客户与项目</h1>
          <p>按客户组织项目，并为每个项目绑定多个 Git 仓库和本地工作路径。</p>
        </div>
        <button
          className="button primary"
          type="button"
          onClick={() => setEditor(createCustomerEditor())}
        >
          新建客户
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

      {editor ? (
        <div
          className="dialog-backdrop"
          onMouseDown={() => !saving && setEditor(null)}
        >
          <section
            ref={editorDialogRef}
            className="dialog platform-resource-editor"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="platform-resource-editor-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">CONFIGURATION</span>
                <h2 id="platform-resource-editor-title">{editorTitle}</h2>
              </div>
            </div>
            <form onSubmit={(event) => void save(event)}>
              <label className="field" htmlFor="platform-resource-name">
                {editor.kind === "customer"
                  ? "客户名称"
                  : editor.kind === "project"
                    ? "项目名称"
                    : "仓库名称"}
                <input
                  id="platform-resource-name"
                  required
                  minLength={2}
                  maxLength={100}
                  value={editor.name}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor({ ...editor, name: event.target.value })
                  }
                />
              </label>
              {editor.kind !== "repository" ? (
                <label
                  className="field wide-field"
                  htmlFor="platform-resource-summary"
                >
                  {editor.kind === "customer" ? "客户说明" : "项目说明"}
                  <textarea
                    id="platform-resource-summary"
                    required
                    minLength={4}
                    maxLength={500}
                    rows={3}
                    value={editor.summary}
                    disabled={saving}
                    onChange={(event) =>
                      setEditor({ ...editor, summary: event.target.value })
                    }
                  />
                </label>
              ) : (
                <>
                  <label
                    className="field wide-field"
                    htmlFor="platform-git-url"
                  >
                    Git 地址
                    <input
                      id="platform-git-url"
                      required
                      value={editor.gitUrl}
                      disabled={saving}
                      placeholder="https://gitee.com/team/project.git"
                      onChange={(event) =>
                        setEditor({ ...editor, gitUrl: event.target.value })
                      }
                    />
                  </label>
                  <label
                    className="field wide-field"
                    htmlFor="platform-local-path"
                  >
                    本地绝对路径
                    <input
                      id="platform-local-path"
                      required
                      value={editor.localPath}
                      disabled={saving}
                      placeholder="D:\\forgex\\project 或 /srv/forgex/project"
                      onChange={(event) =>
                        setEditor({ ...editor, localPath: event.target.value })
                      }
                    />
                  </label>
                  <label className="field" htmlFor="platform-default-branch">
                    默认分支
                    <input
                      id="platform-default-branch"
                      required
                      value={editor.defaultBranch}
                      disabled={saving}
                      placeholder="main"
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          defaultBranch: event.target.value,
                        })
                      }
                    />
                  </label>
                </>
              )}
              {editor.mode === "edit" ? (
                <label className="platform-enabled-toggle">
                  <input
                    type="checkbox"
                    checked={editor.enabled}
                    disabled={saving}
                    onChange={(event) =>
                      setEditor({ ...editor, enabled: event.target.checked })
                    }
                  />
                  当前配置可用
                </label>
              ) : null}
              <div className="dialog-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setEditor(null)}
                >
                  取消
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={saving}
                >
                  {saving
                    ? "正在保存…"
                    : `保存${
                        editor.kind === "customer"
                          ? "客户"
                          : editor.kind === "project"
                            ? "项目"
                            : "仓库"
                      }`}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {loading && customers.length === 0 ? (
        <div className="loading-state" role="status">
          正在读取客户与项目…
        </div>
      ) : customers.length === 0 ? (
        <div className="empty-state">
          <h2>还没有客户和项目</h2>
          <p>先新建客户，再逐层添加项目和代码仓库。</p>
        </div>
      ) : (
        <section className="content-section platform-resource-list">
          <div className="query-toolbar" role="search">
            <label className="query-field grow">
              <span>查询客户或项目</span>
              <input
                type="search"
                aria-label="查询客户或项目"
                placeholder="输入客户名称、项目名称或说明"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="query-field">
              <span>可用状态</span>
              <select
                aria-label="可用状态"
                value={enabledFilter}
                onChange={(event) =>
                  setEnabledFilter(
                    event.target.value as "all" | "enabled" | "disabled",
                  )
                }
              >
                <option value="all">全部状态</option>
                <option value="enabled">仅看可用</option>
                <option value="disabled">仅看停用</option>
              </select>
            </label>
          </div>

          {resourceRows.length === 0 ? (
            <div className="empty-state compact">
              <h2>没有符合条件的客户或项目</h2>
              <p>可以调整查询词或可用状态。</p>
            </div>
          ) : (
            <div className="platform-resource-table" role="table">
              <div className="platform-resource-table-head" role="row">
                <span role="columnheader">客户</span>
                <span role="columnheader">项目</span>
                <span role="columnheader">状态</span>
                <span role="columnheader">仓库</span>
                <span role="columnheader">操作</span>
              </div>
              {resourceRows.map(({ customer, project }) => (
                <div
                  className="platform-resource-table-row"
                  role="row"
                  key={project?.links.self ?? customer.links.self}
                >
                  <div role="cell">
                    <strong>{customer.name}</strong>
                    <small>{customer.summary}</small>
                    <div className="platform-resource-actions compact-actions">
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({
                            kind: "customer",
                            mode: "edit",
                            item: customer,
                            name: customer.name,
                            summary: customer.summary,
                            enabled: customer.enabled,
                          })
                        }
                      >
                        编辑客户
                      </button>
                      <button
                        type="button"
                        aria-label={`为 ${customer.name} 新建项目`}
                        onClick={() =>
                          setEditor({
                            kind: "project",
                            mode: "create",
                            customer,
                            name: "",
                            summary: "",
                          })
                        }
                      >
                        新建项目
                      </button>
                      <button
                        className="danger-action"
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          void remove(customer.name, () =>
                            client.deletePlatformCustomer(
                              customer.links.self,
                              customer.revision,
                            ),
                          )
                        }
                      >
                        删除客户
                      </button>
                    </div>
                  </div>
                  <div role="cell">
                    {project ? (
                      <>
                        <strong>{project.name}</strong>
                        <small>{project.summary}</small>
                      </>
                    ) : (
                      <span>尚未新建项目</span>
                    )}
                  </div>
                  <div role="cell">
                    <span
                      className={`status-pill ${
                        customer.enabled && (project?.enabled ?? true)
                          ? "success"
                          : "neutral"
                      }`}
                    >
                      {customer.enabled && (project?.enabled ?? true)
                        ? "可使用"
                        : "已停用"}
                    </span>
                  </div>
                  <div role="cell">
                    {project ? `${project.repositories.length} 个` : "—"}
                  </div>
                  <div
                    className="platform-resource-actions row-actions"
                    role="cell"
                  >
                    {project ? (
                      <button
                        className="button secondary compact-button"
                        type="button"
                        aria-label={`查看${project.name}详情`}
                        onClick={() =>
                          setSelectedProject({ customer, project })
                        }
                      >
                        查看详情
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedProject ? (
        <div
          className="dialog-backdrop"
          onMouseDown={() => setSelectedProject(null)}
        >
          <section
            ref={projectDetailDialogRef}
            className="dialog platform-project-detail-dialog"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="platform-project-detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="dialog-heading platform-resource-heading">
              <div>
                <span className="eyebrow">{selectedProject.customer.name}</span>
                <h2 id="platform-project-detail-title">
                  {selectedProject.project.name}详情
                </h2>
                <p>{selectedProject.project.summary}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭项目详情"
                onClick={() => setSelectedProject(null)}
              >
                ×
              </button>
            </div>
            <div className="platform-resource-actions detail-actions">
              <button
                type="button"
                onClick={() => {
                  setSelectedProject(null);
                  setEditor({
                    kind: "project",
                    mode: "edit",
                    item: selectedProject.project,
                    name: selectedProject.project.name,
                    summary: selectedProject.project.summary,
                    enabled: selectedProject.project.enabled,
                  });
                }}
              >
                编辑项目
              </button>
              <button
                className="danger-action"
                type="button"
                disabled={saving}
                onClick={() =>
                  void remove(selectedProject.project.name, () =>
                    client.deletePlatformProject(
                      selectedProject.project.links.self,
                      selectedProject.project.revision,
                    ),
                  )
                }
              >
                删除项目
              </button>
            </div>
            <ProjectInitializationPanel
              client={client}
              project={selectedProject.project}
            />
            <div className="repository-list">
              {selectedProject.project.repositories.map((repository) => (
                <div className="repository-row" key={repository.links.self}>
                  <div>
                    <strong>{repository.name}</strong>
                    <span>{repository.gitUrl}</span>
                    <code>{repository.localPath}</code>
                  </div>
                  <span className="repository-branch">
                    {repository.defaultBranch}
                  </span>
                  <div className="platform-resource-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedProject(null);
                        setEditor({
                          kind: "repository",
                          mode: "edit",
                          item: repository,
                          name: repository.name,
                          gitUrl: repository.gitUrl,
                          localPath: repository.localPath,
                          defaultBranch: repository.defaultBranch,
                          enabled: repository.enabled,
                        });
                      }}
                    >
                      编辑
                    </button>
                    <button
                      className="danger-action"
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        void remove(repository.name, () =>
                          client.deleteProjectRepository(
                            repository.links.self,
                            repository.revision,
                          ),
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              className="button secondary compact-button"
              type="button"
              aria-label={`为 ${selectedProject.project.name} 新增代码仓库`}
              onClick={() => {
                setSelectedProject(null);
                setEditor({
                  kind: "repository",
                  mode: "create",
                  project: selectedProject.project,
                  name: "",
                  gitUrl: "",
                  localPath: "",
                  defaultBranch: "main",
                });
              }}
            >
              新增代码仓库
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
