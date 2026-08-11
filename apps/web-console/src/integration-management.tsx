import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { ExtensionCatalogItem, ForgeXClient } from "./api.js";

interface IntegrationManagementProps {
  client: ForgeXClient;
}

const createBindingKey = (): string => crypto.randomUUID();

export function IntegrationManagement({ client }: IntegrationManagementProps) {
  const [tools, setTools] = useState<ExtensionCatalogItem[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [transport, setTransport] = useState<"streamable_http" | "stdio">(
    "streamable_http",
  );
  const [url, setUrl] = useState("");
  const [commandPath, setCommandPath] = useState("");
  const [commandSha256, setCommandSha256] = useState("");
  const [technicalName, setTechnicalName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [effect, setEffect] = useState<"read" | "write" | "external_action">(
    "read",
  );
  const [approval, setApproval] = useState<"automatic" | "review_required">(
    "automatic",
  );
  const [bindingKey, setBindingKey] = useState(createBindingKey);
  const [output, setOutput] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void client
      .listExtensions()
      .then((overview) => {
        if (active) setTools(overview.externalTools);
      })
      .catch((caught: unknown) => {
        if (active) {
          setCatalogError(
            caught instanceof Error ? caught.message : "暂时无法读取外部工具",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    if (effect !== "read") setApproval("review_required");
  }, [effect]);

  const releaseCommand = useMemo(
    () =>
      "npm run --workspace @forgex/extension-admin admin -- mcp-pack --input ./mcp.release.json --output ./mcp.release.bundle.json",
    [],
  );

  const generate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const connection =
      transport === "streamable_http"
        ? {
            schemaVersion: 1,
            connectionBindingKey: bindingKey,
            transport,
            url: url.trim(),
            headers: {},
            allowedTools: [technicalName.trim()],
            timeoutMs: 30_000,
          }
        : {
            schemaVersion: 1,
            connectionBindingKey: bindingKey,
            transport,
            commandPath: commandPath.trim(),
            commandSha256: commandSha256.trim().toLowerCase(),
            args: [],
            environment: {},
            allowedTools: [technicalName.trim()],
            timeoutMs: 30_000,
          };
    setOutput(
      JSON.stringify(
        {
          schemaVersion: 1,
          revision: 1,
          name: name.trim(),
          summary: summary.trim(),
          connection,
          tools: [
            {
              technicalName: technicalName.trim(),
              displayName: displayName.trim(),
              description: description.trim(),
              effect,
              approval,
            },
          ],
        },
        null,
        2,
      ),
    );
    setCopied(false);
  };

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const resetBinding = () => {
    setBindingKey(createBindingKey());
    setOutput("");
    setCopied(false);
  };

  return (
    <div className="integration-management">
      <header className="topbar integration-topbar">
        <div>
          <span className="eyebrow">LOCAL-FIRST INTEGRATIONS</span>
          <h1>MCP 与外部工具</h1>
          <p>连接配置在浏览器本地生成，经过客户设备真实探测后才进入平台。</p>
        </div>
        <span className="filter-button">已接入 {tools.length} 项</span>
      </header>

      {catalogError ? (
        <div className="page-error" role="alert">
          {catalogError}
        </div>
      ) : null}

      <section className="integration-steps" aria-label="MCP 配置流程">
        <div>
          <strong>1. 填写本地连接</strong>
          <span>选择 HTTPS / 本机 HTTP，或受信任的 stdio 启动器。</span>
        </div>
        <div>
          <strong>2. 定义外部工具</strong>
          <span>使用业务名称，并标明读取、写入或外部动作。</span>
        </div>
        <div>
          <strong>3. 本地探测发布</strong>
          <span>客户设备核验身份、协议、工具和 Schema 后签名发布。</span>
        </div>
      </section>

      <form className="integration-form" onSubmit={generate}>
        <section className="content-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">MCP CONNECTION</span>
              <h2>MCP 连接配置</h2>
              <p>地址、启动器和后续凭据不会提交给 ForgeX 控制面。</p>
            </div>
          </div>
          <div className="integration-fields">
            <label className="field" htmlFor="mcp-service-name">
              MCP 服务名称
              <input
                id="mcp-service-name"
                required
                minLength={2}
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：团队通知服务"
              />
            </label>
            <label className="field wide-field" htmlFor="mcp-service-summary">
              服务用途
              <textarea
                id="mcp-service-summary"
                required
                minLength={4}
                maxLength={500}
                rows={3}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
            <label className="field" htmlFor="mcp-transport">
              传输方式
              <select
                id="mcp-transport"
                value={transport}
                onChange={(event) => {
                  setTransport(
                    event.target.value as "streamable_http" | "stdio",
                  );
                  setOutput("");
                }}
              >
                <option value="streamable_http">Streamable HTTP</option>
                <option value="stdio">本地 stdio</option>
              </select>
            </label>
            {transport === "streamable_http" ? (
              <label className="field wide-field" htmlFor="mcp-service-url">
                服务地址
                <input
                  id="mcp-service-url"
                  aria-label="服务地址"
                  type="url"
                  required
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://mcp.example.com/mcp 或 http://127.0.0.1:3210/mcp"
                />
                <small>远程服务必须使用 HTTPS，本机回环地址可使用 HTTP。</small>
              </label>
            ) : (
              <>
                <label className="field wide-field" htmlFor="mcp-command-path">
                  启动器绝对路径
                  <input
                    id="mcp-command-path"
                    required
                    value={commandPath}
                    onChange={(event) => setCommandPath(event.target.value)}
                    placeholder="/opt/forgex/bin/team-mcp"
                  />
                </label>
                <label className="field wide-field" htmlFor="mcp-command-sha">
                  启动器 SHA-256
                  <input
                    id="mcp-command-sha"
                    required
                    pattern="[a-fA-F0-9]{64}"
                    value={commandSha256}
                    onChange={(event) => setCommandSha256(event.target.value)}
                    placeholder="64 位文件摘要"
                  />
                </label>
              </>
            )}
            <div className="binding-key-panel">
              <span>本地连接绑定</span>
              <code>{bindingKey}</code>
              <button type="button" onClick={resetBinding}>
                重新生成
              </button>
            </div>
          </div>
        </section>

        <section className="content-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">EXTERNAL TOOL</span>
              <h2>外部工具配置</h2>
              <p>一个 MCP 服务可以继续在本地文件中追加多个工具定义。</p>
            </div>
          </div>
          <div className="integration-fields">
            <label className="field" htmlFor="mcp-tool-technical-name">
              工具技术名称
              <input
                id="mcp-tool-technical-name"
                required
                pattern="[A-Za-z0-9][A-Za-z0-9_.-]*"
                value={technicalName}
                onChange={(event) => setTechnicalName(event.target.value)}
                placeholder="notifications.send"
              />
            </label>
            <label className="field" htmlFor="mcp-tool-display-name">
              业务动作名称
              <input
                id="mcp-tool-display-name"
                required
                minLength={2}
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="发送团队通知"
              />
            </label>
            <label className="field wide-field" htmlFor="mcp-tool-description">
              业务动作说明
              <textarea
                id="mcp-tool-description"
                required
                minLength={4}
                maxLength={500}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="field" htmlFor="mcp-tool-effect">
              操作影响
              <select
                id="mcp-tool-effect"
                value={effect}
                onChange={(event) =>
                  setEffect(
                    event.target.value as "read" | "write" | "external_action",
                  )
                }
              >
                <option value="read">只读取信息</option>
                <option value="write">修改外部系统</option>
                <option value="external_action">触发外部动作</option>
              </select>
            </label>
            <label className="field" htmlFor="mcp-tool-approval">
              确认策略
              <select
                id="mcp-tool-approval"
                value={approval}
                disabled={effect !== "read"}
                onChange={(event) =>
                  setApproval(
                    event.target.value as "automatic" | "review_required",
                  )
                }
              >
                <option value="automatic">只读操作自动放行</option>
                <option value="review_required">每次需要人工确认</option>
              </select>
            </label>
          </div>
        </section>

        <button className="button primary" type="submit">
          生成本地配置
        </button>
      </form>

      {output ? (
        <section className="content-section integration-output">
          <div className="section-heading">
            <div>
              <span className="eyebrow">LOCAL FILE</span>
              <h2>保存为 mcp.release.json</h2>
            </div>
            <button
              className="button secondary"
              type="button"
              onClick={() => void copyOutput()}
            >
              {copied ? "已复制" : "复制配置"}
            </button>
          </div>
          <p className="local-only-notice">
            配置只在当前浏览器生成，不会上传；认证 Header
            或环境变量请在客户设备本地补充。
          </p>
          <textarea
            aria-label="MCP 本地发布配置"
            readOnly
            rows={20}
            value={output}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="release-command">
            <strong>本地探测命令</strong>
            <code>{releaseCommand}</code>
            <span>
              探测成功后再执行同一工具的 <code>mcp-release</code>
              ，平台才会登记并启用可信能力。
            </span>
          </div>
        </section>
      ) : null}

      <section className="content-section configured-tools">
        <div className="section-heading">
          <div>
            <span className="eyebrow">TRUSTED CATALOG</span>
            <h2>已发布的外部工具</h2>
          </div>
          <span className="filter-button">共 {tools.length} 项</span>
        </div>
        {tools.length === 0 ? (
          <div className="empty-state compact">
            <h3>还没有可信外部工具</h3>
            <p>完成本地探测和发布后，业务能力会出现在这里。</p>
          </div>
        ) : (
          <div className="extension-grid">
            {tools.map((tool) => (
              <article className="extension-card" key={tool.links.self}>
                <strong>{tool.name}</strong>
                <p>{tool.summary}</p>
                <span className="status-pill success">{tool.status}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
