# ForgeX

ForgeX 是一个开源的 AI 软件交付控制面。它把需求澄清、方案、开发、验证、Preview 和人工审批组织成可追踪的交付流程，并能够调度多台分别登录 Codex 的客户设备并行处理需求。

> 当前状态：基础架构建设中，尚未发布可用于生产的版本。

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

```bash
npm install
npm test
npm run typecheck
npm run --workspace @forgex/web-console dev
```

Web Console 默认运行在 `http://localhost:4173`，并把 `/api` 转发到本机 `3000` 端口的 Control Plane。可复制 `apps/web-console/.env.example` 为本地 `.env` 设置项目名称和仅限开发环境的会话 token；不要把生产凭据写进 Vite 环境变量。

## 当前已落地模块

- 需求控制面：版本化需求、确认审批、租户与项目隔离、分页和审计。
- 独立证据链：可信 Runner、公钥验签、交付候选绑定、内容寻址的同源 Preview 网关，以及验收快照。
- Codex 设备网关：最多五个账户、出站心跳、定向轮询、租约续期、fencing、重连回收和幂等完成。
- 扩展控制面：按“业务资料、团队能力、外部工具”管理知识库、Skills 和 MCP 元数据，页面不暴露传输方式、凭据或内部标识。
- 可信 Skill 发布：规范包、内容哈希、独立 Ed25519 评测、管理员激活、可验证回滚与 PostgreSQL 审计；退役公钥仅用于恢复历史状态。
- 可信 MCP 注册：设备本地连接绑定、独立 Ed25519 身份与能力探测、只读自动/变更确认策略、可验证回滚与 PostgreSQL 审计；页面不展示连接或工具编码。
- MCP 调用控制：内容寻址的输入 Schema、严格参数校验、只读自动排队、写入与外部动作由产品负责人确认，并把能力版本、参数摘要和审批记录固化到审计链；控制面不接收明文凭据，凭据只由客户设备上的本地连接绑定提供。
- 共享持久化边界：测试/单机开发使用内存仓储；生产需求主线、审计、交付 outbox、Preview 制品和设备舰队均使用 PostgreSQL 事务仓储。
- 人性化 Web 工作台：使用业务语言展示需求状态、下一步和验收标准，支持需求创建、详情下钻和受服务端授权约束的操作；设备中心可查看五账户容量、在线忙闲和当前交付，页面已覆盖桌面/移动端、明暗主题和键盘操作。

浏览器生产认证由同源认证层签发名为 `forgex_session` 的 HttpOnly Cookie，建议同时启用 `Secure`、`SameSite=Strict` 和 `Path=/`。Control Plane 对 Cookie 会话的写请求额外要求 `X-ForgeX-CSRF: 1`；非浏览器客户端仍可通过现有 `Authorization: Bearer ...` 适配器接入。Cookie 的签发、轮换和注销属于后续身份模块，不由 Web 静态资源处理。

生产接入前，需要按编号依次执行 [Worker 舰队迁移](packages/postgres/migrations/0001_worker_fleet.sql)、[需求控制面迁移](packages/postgres/migrations/0002_requirement_control_plane.sql)、[验收审计迁移](packages/postgres/migrations/0003_requirement_acceptance_audit.sql)、[Preview 制品迁移](packages/postgres/migrations/0004_preview_artifacts.sql)、[扩展目录迁移](packages/postgres/migrations/0005_extension_catalog.sql)、[Skill 注册表迁移](packages/postgres/migrations/0006_skill_registry.sql)、[MCP 注册表迁移](packages/postgres/migrations/0007_mcp_registry.sql)、[MCP 调用迁移](packages/postgres/migrations/0008_mcp_invocations.sql) 和 [Worker 任务类型迁移](packages/postgres/migrations/0009_worker_work_kinds.sql)，并向所有 API 副本注入同一数据库上的 `PostgresWorkerFleetRepository`、`PostgresRequirementRepository`、`PostgresPreviewArtifactStore`、`PostgresExtensionCatalogRepository`、`PostgresSkillRegistryRepository`、`PostgresSkillArtifactStore`、`PostgresMcpRegistryRepository`、`PostgresMcpInputSchemaStore` 与 `PostgresMcpInvocationRepository`。需求仓储还必须注入保留当前及历史验证公钥的 `EvidenceAuthority`；Skill 与 MCP 注册表同样必须保留历史验证公钥，并把退役密钥设置为仅核验历史记录。当前仍是预发布版本，不应直接用于生产交付。

详细范围见 [产品章程](docs/product/PRODUCT_CHARTER.md) 和 [用户旅程](docs/product/USER_JOURNEYS.md)。
