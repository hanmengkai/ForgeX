import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ExtensionCatalogItem,
  ExtensionCatalogOverview,
  ForgeXClient,
} from "./api.js";
import { KnowledgeBaseCenter } from "./knowledge-base-center.js";
import { McpRequestDialog } from "./mcp-request-dialog.js";

interface ExtensionCenterProps {
  client: ForgeXClient;
}

const emptyOverview: ExtensionCatalogOverview = {
  businessKnowledge: [],
  teamCapabilities: [],
  externalTools: [],
};

const tone = (status: ExtensionCatalogItem["status"]): string => {
  if (status === "可使用") return "success";
  if (status === "正在更新") return "running";
  if (status === "需要处理") return "attention";
  return "neutral";
};

function ExtensionSection({
  title,
  description,
  emptyTitle,
  items,
  onRequestExternalTool,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  items: ExtensionCatalogItem[];
  onRequestExternalTool?: ((toolsUrl: string) => void) | undefined;
}) {
  return (
    <section className="content-section extension-section">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="filter-button">共 {items.length} 项</span>
      </div>
      {items.length === 0 ? (
        <div className="empty-state compact">
          <h3>{emptyTitle}</h3>
          <p>管理员完成项目配置后会自动出现在这里。</p>
        </div>
      ) : (
        <div className="extension-grid">
          {items.map((item) => {
            const toolsUrl =
              "tools" in item.links ? item.links.tools : undefined;
            return (
              <article className="extension-card" key={item.links.self}>
                <div className="extension-card-heading">
                  <strong>{item.name}</strong>
                  <span className={`status-pill ${tone(item.status)}`}>
                    {item.status}
                  </span>
                </div>
                <p>{item.summary}</p>
                <div className="extension-card-meta">
                  <span>{item.detail}</span>
                  <small>{item.supportingText}</small>
                </div>
                {onRequestExternalTool &&
                item.status === "可使用" &&
                toolsUrl ? (
                  <button
                    className="button secondary compact-button"
                    type="button"
                    onClick={() => onRequestExternalTool(toolsUrl)}
                  >
                    发起业务操作
                    <span className="sr-only">：{item.name}</span>
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function ExtensionCenter({ client }: ExtensionCenterProps) {
  const [overview, setOverview] = useState<ExtensionCatalogOverview | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mcpToolsUrl, setMcpToolsUrl] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listExtensions();
      if (generation === generationRef.current) setOverview(result);
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "暂时无法读取扩展目录，请稍后重试",
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
    const current = overview ?? emptyOverview;
    return {
      knowledge: current.businessKnowledge.length,
      skills: current.teamCapabilities.length,
      tools: current.externalTools.length,
    };
  }, [overview]);

  return (
    <div className="extension-center">
      <header className="topbar extension-topbar">
        <div>
          <span className="eyebrow">项目可用能力</span>
          <h1>扩展中心</h1>
          <p>把团队资料、标准工作方法和外部系统安全地交给 AI 使用。</p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "正在刷新…" : "刷新目录"}
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

      {notice ? (
        <div className="page-notice" role="status">
          {notice}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="loading-state" role="status">
          正在整理项目扩展…
        </div>
      ) : overview ? (
        <>
          <section className="extension-summary" aria-label="扩展概况">
            <div>
              <span>业务资料</span>
              <strong>{counts.knowledge}</strong>
              <small>需求与业务上下文</small>
            </div>
            <div>
              <span>团队能力</span>
              <strong>{counts.skills}</strong>
              <small>经过验证的工作方法</small>
            </div>
            <div>
              <span>外部工具</span>
              <strong>{counts.tools}</strong>
              <small>按权限开放的系统能力</small>
            </div>
          </section>
          <KnowledgeBaseCenter
            client={client}
            items={overview.businessKnowledge}
            createAction={overview.links?.actions.createKnowledge}
            onChanged={load}
          />
          <ExtensionSection
            title="团队能力"
            description="把团队 SOP 变成可版本化、可评估的执行能力。"
            emptyTitle="还没有团队能力"
            items={overview.teamCapabilities}
          />
          <ExtensionSection
            title="外部工具"
            description="只开放业务动作，不把数据库、终端或凭据直接交给 AI。"
            emptyTitle="还没有外部工具"
            items={overview.externalTools}
            onRequestExternalTool={(toolsUrl) => {
              setNotice(null);
              setMcpToolsUrl(toolsUrl);
            }}
          />
        </>
      ) : null}
      {mcpToolsUrl ? (
        <McpRequestDialog
          client={client}
          toolsUrl={mcpToolsUrl}
          onClose={() => setMcpToolsUrl(null)}
          onSubmitted={() => {
            setNotice("操作已发起，可在“操作确认”中查看进度。");
          }}
        />
      ) : null}
    </div>
  );
}
