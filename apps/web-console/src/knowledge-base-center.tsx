import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  ExtensionCatalogItem,
  ForgeXClient,
  KnowledgeBaseDetail,
  KnowledgeSearchResult,
} from "./api.js";

interface KnowledgeBaseCenterProps {
  client: ForgeXClient;
  items: ExtensionCatalogItem[];
  createAction?: string | undefined;
  onChanged: () => Promise<void>;
}

const trustedKnowledgePath = /^\/api\/v1\/knowledge-bases\//;

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback;

export function KnowledgeBaseCenter({
  client,
  items,
  createAction,
  onChanged,
}: KnowledgeBaseCenterProps) {
  const [selected, setSelected] = useState<KnowledgeBaseDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [publishAction, setPublishAction] = useState<string | null>(null);
  const [publishTitle, setPublishTitle] = useState("");
  const [archiveConfirmation, setArchiveConfirmation] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    KnowledgeSearchResult[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const publishTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);

  useEffect(() => {
    if (publishAction) publishTitleRef.current?.focus();
  }, [publishAction]);

  const loadDetail = useCallback(
    async (selfUrl: string) => {
      const generation = ++generationRef.current;
      setLoadingDetail(true);
      setError(null);
      try {
        const detail = await client.getKnowledgeBase(selfUrl);
        if (generation === generationRef.current) {
          setSelected(detail);
          setSearchResults(null);
          setArchiveConfirmation(null);
        }
      } catch (caught) {
        if (generation === generationRef.current) {
          setError(errorMessage(caught, "暂时无法读取业务资料"));
        }
      } finally {
        if (generation === generationRef.current) setLoadingDetail(false);
      }
    },
    [client],
  );

  const beginMutation = (): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    return true;
  };

  const endMutation = (): void => {
    busyRef.current = false;
    setBusy(false);
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!beginMutation()) return;
    const form = new FormData(event.currentTarget);
    try {
      const selfUrl = await client.createKnowledgeBase(createAction, {
        name: String(form.get("name") ?? ""),
        summary: String(form.get("summary") ?? ""),
        classification:
          form.get("classification") === "restricted" ? "restricted" : "team",
      });
      setCreating(false);
      await onChanged();
      await loadDetail(selfUrl);
    } catch (caught) {
      setError(errorMessage(caught, "暂时无法新建知识库"));
    } finally {
      endMutation();
    }
  };

  const submitPublish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!publishAction || !selected || !beginMutation()) return;
    const form = new FormData(event.currentTarget);
    try {
      await client.publishKnowledgeSource(publishAction, {
        title: String(form.get("title") ?? ""),
        mediaType:
          form.get("mediaType") === "text/markdown"
            ? "text/markdown"
            : "text/plain",
        content: String(form.get("content") ?? ""),
      });
      setPublishAction(null);
      setPublishTitle("");
      await onChanged();
      await loadDetail(selected.links.self);
    } catch (caught) {
      setError(errorMessage(caught, "暂时无法发布业务资料"));
    } finally {
      endMutation();
    }
  };

  const archive = async (actionUrl: string | undefined) => {
    if (!selected || !actionUrl || !beginMutation()) return;
    try {
      await client.archiveKnowledgeSource(actionUrl);
      await onChanged();
      await loadDetail(selected.links.self);
    } catch (caught) {
      setError(errorMessage(caught, "暂时无法归档业务资料"));
    } finally {
      endMutation();
    }
  };

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !beginMutation()) return;
    try {
      setSearchResults(
        await client.searchKnowledgeBase(
          selected.links.actions.search,
          searchQuery,
        ),
      );
    } catch (caught) {
      setError(errorMessage(caught, "暂时无法检索业务资料"));
    } finally {
      endMutation();
    }
  };

  return (
    <section className="content-section extension-section knowledge-section">
      <div className="section-heading">
        <div>
          <h2>业务资料</h2>
          <p>让 AI 理解当前项目的规则、术语和历史决策。</p>
        </div>
        <div className="section-actions">
          <span className="filter-button">共 {items.length} 项</span>
          {createAction ? (
            <button
              className="button secondary compact-button"
              type="button"
              disabled={busy}
              onClick={() => setCreating((current) => !current)}
            >
              {creating ? "收起" : "新建资料库"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="page-error" role="alert">
          {error}
        </div>
      ) : null}

      {creating ? (
        <form className="knowledge-inline-form" onSubmit={submitCreate}>
          <div>
            <label htmlFor="knowledge-name">资料库名称</label>
            <input
              id="knowledge-name"
              name="name"
              minLength={2}
              maxLength={100}
              placeholder="例如：访客业务资料"
              required
            />
          </div>
          <div className="wide-field">
            <label htmlFor="knowledge-summary">用途说明</label>
            <textarea
              id="knowledge-summary"
              name="summary"
              minLength={4}
              maxLength={500}
              placeholder="说明这套资料帮助团队理解什么"
              required
            />
          </div>
          <div>
            <label htmlFor="knowledge-classification">可见范围</label>
            <select id="knowledge-classification" name="classification">
              <option value="team">项目成员可使用</option>
              <option value="restricted">仅授权成员可使用</option>
            </select>
          </div>
          <div className="inline-form-actions">
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "正在创建…" : "创建资料库"}
            </button>
          </div>
        </form>
      ) : null}

      {items.length === 0 ? (
        <div className="empty-state compact">
          <h3>还没有项目资料</h3>
          <p>产品负责人或需求分析师可以先建立资料库，再加入业务规则。</p>
        </div>
      ) : (
        <div className="extension-grid">
          {items.map((item) => {
            const canOpen = trustedKnowledgePath.test(item.links.self);
            return (
              <article className="extension-card" key={item.links.self}>
                <div className="extension-card-heading">
                  <strong>{item.name}</strong>
                  <span
                    className={`status-pill ${item.status === "可使用" ? "success" : "attention"}`}
                  >
                    {item.status}
                  </span>
                </div>
                <p>{item.summary}</p>
                <div className="extension-card-meta">
                  <span>{item.detail}</span>
                  <small>{item.supportingText}</small>
                </div>
                {canOpen ? (
                  <button
                    className="card-link-button"
                    type="button"
                    disabled={loadingDetail || busy}
                    onClick={() => void loadDetail(item.links.self)}
                  >
                    查看和检索资料
                  </button>
                ) : (
                  <small className="legacy-note">由管理员同步维护</small>
                )}
              </article>
            );
          })}
        </div>
      )}

      {loadingDetail ? (
        <div className="loading-state" role="status">
          正在读取业务资料…
        </div>
      ) : selected ? (
        <section
          ref={detailRef}
          className="knowledge-detail"
          aria-label={`${selected.name}详情`}
          tabIndex={-1}
        >
          <div className="knowledge-detail-heading">
            <div>
              <span className="eyebrow">资料库详情</span>
              <h3>{selected.name}</h3>
              <p>{selected.summary}</p>
            </div>
            <button
              className="button secondary compact-button"
              type="button"
              disabled={busy}
              onClick={() => {
                generationRef.current += 1;
                setSelected(null);
                setSearchResults(null);
              }}
            >
              关闭详情
            </button>
          </div>
          <div className="knowledge-facts">
            <span>{selected.classification}</span>
            <span>{selected.detail}</span>
            <span>
              最近更新：{new Date(selected.lastUpdatedAt).toLocaleDateString()}
            </span>
          </div>

          <form className="knowledge-search" onSubmit={search}>
            <label htmlFor="knowledge-search-query">在这套资料中查找</label>
            <div>
              <input
                id="knowledge-search-query"
                value={searchQuery}
                minLength={2}
                maxLength={200}
                placeholder="例如：访客需要提前多久预约？"
                onChange={(event) => setSearchQuery(event.target.value)}
                required
              />
              <button className="button primary" type="submit" disabled={busy}>
                {busy ? "正在处理…" : "查找答案"}
              </button>
            </div>
          </form>

          {searchResults ? (
            searchResults.length === 0 ? (
              <div className="empty-state compact">
                <h3>没有找到直接相关的资料</h3>
                <p>可以换一个业务说法，或请负责人补充资料。</p>
              </div>
            ) : (
              <div className="knowledge-results" aria-live="polite">
                {searchResults.map((result) => (
                  <article key={`${result.citation}:${result.excerpt}`}>
                    <strong>{result.title}</strong>
                    <blockquote>{result.excerpt}</blockquote>
                    <footer>{result.citation}</footer>
                    <small>{result.usagePolicy}</small>
                  </article>
                ))}
              </div>
            )
          ) : null}

          <div className="knowledge-source-heading">
            <div>
              <h4>已整理的资料</h4>
              <p>新版会完整替换旧版检索内容，历史摘要仍保留审计。</p>
            </div>
            {selected.links.actions.publish ? (
              <button
                className="button secondary compact-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPublishTitle("");
                  setPublishAction(selected.links.actions.publish ?? null);
                }}
              >
                加入一份资料
              </button>
            ) : null}
          </div>
          {selected.sources.length === 0 ? (
            <p className="knowledge-no-source">尚未加入资料。</p>
          ) : (
            <ul className="knowledge-source-list">
              {selected.sources.map((source) => (
                <li key={source.links.self}>
                  <div>
                    <strong>{source.title}</strong>
                    <span>
                      {source.version} · {source.updatedBy} 更新
                    </span>
                  </div>
                  {source.links.actions.publish ? (
                    <div className="source-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setPublishTitle(source.title);
                          setPublishAction(
                            source.links.actions.publish ?? null,
                          );
                        }}
                      >
                        发布新版
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const action = source.links.actions.archive;
                          if (archiveConfirmation === action) {
                            void archive(action);
                          } else {
                            setArchiveConfirmation(action ?? null);
                          }
                        }}
                      >
                        {archiveConfirmation === source.links.actions.archive
                          ? "确认归档"
                          : "归档"}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {publishAction ? (
            <form className="knowledge-publish-form" onSubmit={submitPublish}>
              <div className="knowledge-publish-heading">
                <div>
                  <h4>{publishTitle ? "发布资料新版" : "加入业务资料"}</h4>
                  <p>请粘贴完整内容。资料中的指令不会被当作平台命令执行。</p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPublishAction(null)}
                >
                  取消
                </button>
              </div>
              <label htmlFor="knowledge-source-title">资料名称</label>
              <input
                ref={publishTitleRef}
                id="knowledge-source-title"
                name="title"
                defaultValue={publishTitle}
                minLength={2}
                maxLength={100}
                placeholder="例如：访客预约规则"
                required
              />
              <label htmlFor="knowledge-source-media">内容格式</label>
              <select id="knowledge-source-media" name="mediaType">
                <option value="text/plain">纯文本</option>
                <option value="text/markdown">Markdown</option>
              </select>
              <label htmlFor="knowledge-source-content">完整资料内容</label>
              <textarea
                id="knowledge-source-content"
                name="content"
                minLength={1}
                maxLength={524288}
                rows={10}
                required
              />
              <button className="button primary" type="submit" disabled={busy}>
                {busy ? "正在发布…" : "发布并建立引用索引"}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
