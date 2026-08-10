# ForgeX

ForgeX 是一个开源的 AI 软件交付控制面。它把需求澄清、方案、开发、验证、Preview 和人工审批组织成可追踪的交付流程，并能够调度多台分别登录 Codex 的客户设备并行处理需求。

> 当前状态：`0.1.0` 预发布版。仓库提供完整的本地部署、持久化控制面、Web、设备 Worker 与独立验证 Runner；公开上线前仍需由部署者接入组织身份源、TLS、备份和监控。

## 为谁设计

- 产品经理：看到需求进度、效果、风险和需要确认的事项。
- 需求分析师：管理需求版本、澄清问题和验收条件。
- 初级研发：理解任务、查看变更和测试证据，并在需要时接管。

普通页面不会用内部 ID、编码或技术日志淹没用户。所有技术细节都保留在可下钻的专家视图中。

## 核心原则

1. 需求而不是聊天记录是交付主线。
2. 每个阶段产生结构化、版本化的 Artifact。
3. Codex 登录留在客户设备本地，平台通过租约调度最多五个账户并行工作。
4. CI 和独立 Runner 产生验证结论，Agent 不能自证通过。
5. 不可逆操作必须经过明确的人工审批。

## 本地验证

需要 Node.js 22.13 或更高版本，推荐使用当前 Node.js 24 LTS。

```bash
npm install
npm test
npm run typecheck
npm run --workspace @forgex/web-console dev
```

数据库迁移由带校验和账本和 PostgreSQL advisory lock 的统一命令执行，不要再逐个手工运行 SQL：

```bash
FORGEX_DATABASE_URL=postgresql://forgex:password@localhost:5432/forgex npm run db:migrate
```

## Docker Compose 本地部署

1. 复制 `deploy/.env.example` 为 `deploy/.env`，用 `openssl rand -hex 32` 生成 64 位十六进制数据库密码，并把同一个值分别写入 `FORGEX_POSTGRES_PASSWORD` 与已经 URL 编码的 `FORGEX_DATABASE_URL`。如使用其他字符集，必须先对 URL 用户信息部分做 percent-encoding，不能直接把原始密码拼进 URI。
2. 复制 `deploy/config/control-plane.example.json` 为 `deploy/config/control-plane.json`。
3. 生成至少 24 字符的随机访问令牌，只把它的 SHA-256 写入 `tokenSha256`；令牌明文只交给对应用户，不得提交 Git。人员令牌与 Runner 令牌不得复用。
4. 对最终的 `control-plane.json` 计算 SHA-256，并写入 `FORGEX_CONTROL_PLANE_CONFIG_SHA256`。Linux 可用 `sha256sum deploy/config/control-plane.json`，PowerShell 可用 `(Get-FileHash deploy/config/control-plane.json -Algorithm SHA256).Hash.ToLowerInvariant()`。任何授权配置变化都必须同步更新该摘要，并会立即令旧浏览器会话失效。
5. 从仓库根目录启动：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Web Console 位于 `http://localhost:8080`，Control Plane 只在 Compose 内网暴露。迁移服务成功退出后 API 才会启动，Web 又会等待数据库就绪探针通过。公开部署必须在 Web 前增加 TLS，并把示例标识、摘要和数据库密码全部替换。

独立验证 Runner 使用受保护的本地会话、Ed25519 私钥和日志完整性密钥，从权威 Git 仓库取出精确提交，再在无网络、非 root、资源受限的 Docker 容器中运行固定套件。验证镜像必须使用 `sha256` 摘要，Docker 与 Git 程序也会在每次使用前核对本地 SHA-256；Runner 不执行仓库提供的 shell 字符串，也不会把容器错误原文或秘密写入普通日志。先复制 [Runner 配置示例](services/verification-runner/runner.config.example.json)，为每个已确认交付版本配置完整计划和对应 `planHash`，预拉取不可变镜像，并让 Runner 使用无特权 Docker/容器运行身份。配置、会话、私钥、完整性密钥和 journal 父目录必须只允许 Runner 控制器身份访问。启动命令：

```bash
npm run --workspace @forgex/verification-runner build
FORGEX_RUNNER_CONFIG=/absolute/path/runner.config.json npm run --workspace @forgex/verification-runner start
```

客户设备 Worker 使用本机 Codex 登录，不把 Codex 凭据上传控制面。每个 Codex 账户应使用独立受限操作系统账号或容器和该隔离身份独占的空 `codexHomePath`，先把 Codex CLI 配置为系统 keyring 凭据存储并完成登录；该目录不得出现 `auth.json`、个人 `config.toml`、第三方 MCP、Skills、Hooks 或插件，隔离系统镜像也不得预装额外 Codex 配置。仓库随设备包交付 `forgex-codex-isolation-launcher`（构建产物为 `dist/isolation-launcher-main.js`），它在同一次 `--forgex-codex-run` 中先验证身份和文件边界，再调用固定版本的官方 `@openai/codex-sdk`；同控制器身份运行会直接失败。每次任务都把仓库标记为不可信，使仓库内 `.codex/config.toml` 不能扩展工具面。模型侧关闭通用 Shell、统一执行、图片读取、浏览器、桌面操作、应用、插件、记忆、Hooks、工作区依赖、网络和 Web 搜索，只保留内置 `apply_patch` 与 ForgeX 自带的只读工作树 MCP；启动前会读取真实 Codex CLI feature inventory，任何未分类的默认启用能力都会失败关闭，并用同一组运行参数读取真实 MCP inventory，要求唯一启用的服务及其命令、参数和工具白名单都与 ForgeX 可信清单完全一致。该 MCP 只提供有界的列目录、读普通业务文本和字面量搜索，不执行命令、不读取 `.git`、凭据文件、符号链接或工作树外路径。生产需用 root/管理员持有且其他用户不可写的 OS 包装器，在独立账号或容器内调用该 launcher。复制 [设备配置示例](services/device-worker/worker.config.example.json)，填入包装器路径与真实 SHA-256，再替换设备连接信息、项目与仓库标识以及本机绝对路径，然后执行：

```bash
npm run --workspace @forgex/device-worker build
FORGEX_WORKER_CONFIG=/absolute/path/worker.config.json npm run --workspace @forgex/device-worker start
```

配置文件包含短期设备会话密钥，应限制为 Worker 控制器身份可读且不得提交 Git。`completionJournalPath` 的父目录必须预先创建，并与配置文件一样只允许控制器身份、Windows 的 `SYSTEM` 和管理员访问；隔离 Codex 身份不得读取这些路径。`codexHomePath` 则由隔离账号独占，控制器不读取。Worker 启动时会检查本地 ACL/mode、启动器及父目录不可被其他用户改写、启动器摘要和同一设备进程锁；每次任务还会重新验摘要，并让该启动器在同一隔离实例内完成文件探测和 SDK 执行，不能证明时不会产生 Codex 结果。Codex 只读取和编辑受控工作树，不能执行命令或写 `.git`；由可信 Worker 宿主检查分支、改动和疑似凭据后生成固定身份的本地提交，测试结论只接受独立 Runner 证据。完成意图和结果先通过文件与父目录同步（Windows 使用 write-through 原子移动）写入本地 journal，再以内容摘要绑定的幂等请求上报；进程或设备意外退出后可恢复，模型自由文本和自报测试不会上传。整个过程仍需独立 Runner 验证。

`mcpConnections` 只保存在客户设备的私有配置中。每条连接按控制面签发的 opaque `connectionBindingKey` 精确映射，`stdio` 启动器在 Worker 启动和每次调用前都核验普通文件、其他用户不可写的父目录与 SHA-256；解释器实际加载的脚本或配置文件必须使用 `trusted_file` 参数逐项声明绝对路径和 SHA-256，普通参数只允许不解释为路径或代码的受限值。远程连接只允许 HTTPS（本机回环可用 HTTP）且禁止重定向。设备在真实调用前重新核对工具白名单、输入 Schema、规范参数摘要和租约 fencing；凭据仅注入本地 MCP 进程或请求头，不进入控制面。非只读操作在调用前先写持久执行意图，崩溃后不会自动重做，而是进入“结果待人工核对”；只读操作才允许从同一意图安全重试。

Web Console 默认运行在 `http://localhost:4173`，并把 `/api` 转发到本机 `3000` 端口的 Control Plane。可复制 `apps/web-console/.env.example` 为本地 `.env` 设置项目名称和仅限开发环境的会话 token；不要把生产凭据写进 Vite 环境变量。

## 当前已落地模块

- 需求控制面：版本化需求、确认审批、租户与项目隔离、分页和审计。
- 独立证据链：可信 Runner、公钥验签、交付候选绑定、内容寻址的同源 Preview 网关，以及验收快照。
- Codex 设备网关：最多五个账户、出站心跳、定向轮询、租约续期、fencing、重连回收和幂等完成。
- Codex 设备 Worker：使用官方 TypeScript Codex SDK，在仓库外独立 worktree 中执行已确认需求；仓库身份、需求版本、基线提交、新提交、分支和永久完成证明形成可恢复审计链，开发测试不能替代独立验收证据。
- 扩展控制面：按“业务资料、团队能力、外部工具”管理知识库、Skills 和 MCP 元数据，页面不暴露传输方式、凭据或内部标识。
- 引用优先的业务知识库：需求分析师可发布和归档纯文本或 Markdown 资料，系统保留内容摘要与版本审计，并以带资料名、版本和段落的引用返回检索结果；资料内容始终按参考信息处理，不能覆盖平台指令或审批边界。
- 可信 Skill 发布：规范包、内容哈希、独立 Ed25519 评测、管理员激活、可验证回滚与 PostgreSQL 审计；退役公钥仅用于恢复历史状态。
- 可信 MCP 注册：设备本地连接绑定、独立 Ed25519 身份与能力探测、只读自动/变更确认策略、可验证回滚与 PostgreSQL 审计；页面不展示连接或工具编码。
- MCP 调用控制：内容寻址的输入 Schema、严格参数校验、只读自动排队、写入与外部动作由产品负责人确认，并把能力版本、参数摘要和审批记录固化到审计链；设备 Worker 已通过官方 MCP SDK 按本地连接精确执行并支持崩溃恢复，控制面不接收明文凭据。
- 共享持久化边界：测试/单机开发使用内存仓储；生产需求主线、审计、交付 outbox、Preview 制品和设备舰队均使用 PostgreSQL 事务仓储。
- 人性化 Web 工作台：使用业务语言展示需求状态、下一步和验收标准，支持需求创建、详情下钻和受服务端授权约束的操作；设备中心可查看五账户容量、在线忙闲和当前交付，页面已覆盖桌面/移动端、明暗主题和键盘操作。

浏览器会先用管理员单独发放的访问令牌调用同源会话入口，Control Plane 验证令牌摘要后交换为随机 opaque 会话；数据库只保存会话摘要、服务端到期时间和当前授权配置版本。返回的 `forgex_session` Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；除明确用于本机 HTTP 的配置外还必须启用 `Secure`。同一人员重新登录会撤销其旧会话，注销、服务端到期、删除或降权人员以及替换运行配置摘要都会让旧 Cookie 返回 401。Web 不把令牌写入 `localStorage`、构建变量或普通日志，成功登录后立即清空输入；Cookie 写请求要求 `X-ForgeX-CSRF: 1`。非浏览器客户端仍可使用 `Authorization: Bearer ...`。组织级 SSO 可在相同 `SessionAuthenticator` 边界接入。

生产接入前必须运行 `npm run db:migrate`。统一迁移器会按编号校验并执行从 [0001_worker_fleet.sql](packages/postgres/migrations/0001_worker_fleet.sql) 到 [0014_browser_sessions.sql](packages/postgres/migrations/0014_browser_sessions.sql) 的完整迁移链，禁止改写已登记迁移或跳过中间版本；Control Plane 的 readiness 也会核对名称与 SHA-256，不完整或漂移时返回 503。所有 API 副本必须连接同一数据库，并使用稳定且与设备端一致的 `projectKey`、`repositoryKey`。需求、Runner、Skill 与 MCP 的验证器必须保留历史公钥，并把退役密钥设置为仅核验历史记录。当前仍是预发布版本，不应直接用于生产交付。

当前完整顺序为 `0001_worker_fleet.sql`、`0002_requirement_control_plane.sql`、`0003_requirement_acceptance_audit.sql`、`0004_preview_artifacts.sql`、`0005_extension_catalog.sql`、`0006_skill_registry.sql`、`0007_mcp_registry.sql`、`0008_mcp_invocations.sql`、`0009_worker_work_kinds.sql`、`0010_knowledge_bases.sql`、`0011_delivery_runs.sql`、`0012_runner_verification.sql`、`0013_verification_failures.sql`、`0014_browser_sessions.sql`。生产装配共享 `PostgresWorkerFleetRepository`、`PostgresRequirementRepository`、`PostgresPreviewArtifactStore`、`PostgresExtensionCatalogRepository`、`PostgresSkillRegistryRepository`、`PostgresSkillArtifactStore`、`PostgresMcpRegistryRepository`、`PostgresMcpInputSchemaStore`、`PostgresMcpInvocationRepository` 与 `PostgresKnowledgeBaseRepository`，并由 `PostgresBrowserSessionManager` 保存有界、可撤销的浏览器会话摘要。

详细范围见 [产品章程](docs/product/PRODUCT_CHARTER.md) 和 [用户旅程](docs/product/USER_JOURNEYS.md)。
