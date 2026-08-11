import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  ForgeXClient,
  PlatformCustomerItem,
  PlatformProjectItem,
  PlatformRepositoryItem,
} from "./api.js";

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

export function PlatformConfigurationCenter({
  client,
}: PlatformConfigurationCenterProps) {
  const [customers, setCustomers] = useState<PlatformCustomerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<ResourceEditor | null>(null);
  const generationRef = useRef(0);

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
        <section className="content-section platform-resource-editor">
          <div className="section-heading">
            <div>
              <span className="eyebrow">CONFIGURATION</span>
              <h2>{editorTitle}</h2>
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
                <label className="field wide-field" htmlFor="platform-git-url">
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
        <div className="customer-grid">
          {customers.map((customer) => (
            <section className="customer-card" key={customer.links.self}>
              <div className="platform-resource-heading">
                <div>
                  <span className="eyebrow">客户</span>
                  <h2>{customer.name}</h2>
                  <p>{customer.summary}</p>
                </div>
                <div className="platform-resource-actions">
                  <span
                    className={`status-pill ${customer.enabled ? "success" : "neutral"}`}
                  >
                    {customer.enabled ? "可使用" : "已停用"}
                  </span>
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
                    编辑
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
                    删除
                  </button>
                </div>
              </div>
              <div className="project-list">
                {customer.projects.map((project) => (
                  <article className="project-card" key={project.links.self}>
                    <div className="platform-resource-heading compact-heading">
                      <div>
                        <span className="eyebrow">项目</span>
                        <h3>{project.name}</h3>
                        <p>{project.summary}</p>
                      </div>
                      <div className="platform-resource-actions">
                        <button
                          type="button"
                          onClick={() =>
                            setEditor({
                              kind: "project",
                              mode: "edit",
                              item: project,
                              name: project.name,
                              summary: project.summary,
                              enabled: project.enabled,
                            })
                          }
                        >
                          编辑项目
                        </button>
                        <button
                          className="danger-action"
                          type="button"
                          disabled={saving}
                          onClick={() =>
                            void remove(project.name, () =>
                              client.deletePlatformProject(
                                project.links.self,
                                project.revision,
                              ),
                            )
                          }
                        >
                          删除项目
                        </button>
                      </div>
                    </div>
                    <div className="repository-list">
                      {project.repositories.map((repository) => (
                        <div
                          className="repository-row"
                          key={repository.links.self}
                        >
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
                              onClick={() =>
                                setEditor({
                                  kind: "repository",
                                  mode: "edit",
                                  item: repository,
                                  name: repository.name,
                                  gitUrl: repository.gitUrl,
                                  localPath: repository.localPath,
                                  defaultBranch: repository.defaultBranch,
                                  enabled: repository.enabled,
                                })
                              }
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
                      aria-label={`为 ${project.name} 新增代码仓库`}
                      onClick={() =>
                        setEditor({
                          kind: "repository",
                          mode: "create",
                          project,
                          name: "",
                          gitUrl: "",
                          localPath: "",
                          defaultBranch: "main",
                        })
                      }
                    >
                      新增代码仓库
                    </button>
                  </article>
                ))}
              </div>
              <button
                className="button secondary compact-button"
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
