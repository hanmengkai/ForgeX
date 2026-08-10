# ADR-0006：需求主线、审计与交付 outbox 使用同一 PostgreSQL 事务

## 状态

已接受。

## 决策

生产环境使用 `PostgresRequirementRepository` 保存完整需求规格、工作流快照、审计事件和交付 outbox。每个写事务先以 `tenantKey + projectKey` 获取 PostgreSQL advisory transaction lock，再恢复并校验聚合、执行领域动作，最后在同一事务提交需求、审计和 outbox。

工作流快照是版本化的持久化契约。每个修订保存完整规范化 `RequirementSpec` 的 SHA-256 摘要，仓储读写时同时核对完整规格摘要以及标题、目标和验收条件投影，避免把“已确认工作流 B”和“未确认规格 A”拼成一项交付。恢复时还必须重新校验租户、项目、需求、修订、审批、交付候选和 Runner 原始签名，不能把数据库中的 JSON 当作可信运行时对象。普通需求列表由数据库按单调 `position` 游标分页，不读取全量记录后切片。

交付 outbox 以 `tenantKey + projectKey + requirementKey + requirementRevision` 建立唯一约束。设备轮询通过真实会话认证后，可以按租户扫描所有项目的 pending 记录；派发成功后回到记录所属项目事务写入派发时间和审计。

## 原因

- API 重启或多副本部署时，需求状态、审计和待派发工作不能丢失。
- “进入交付”和“创建待派发记录”必须原子完成。
- 已认证设备可以服务租户内多个项目，但不能混淆项目或需求版本。
- 数据库内容可能损坏或被错误迁移，恢复聚合时仍需执行领域不变量校验。

## 后果

- 所有 API 副本必须共享同一个 PostgreSQL 数据库，内存仓储仅用于测试和单机开发。
- 项目内需求写入串行化，后续如出现热点项目，需要在保持聚合原子性的前提下细化锁粒度。
- 迁移顺序为 `0001_worker_fleet.sql`、`0002_requirement_control_plane.sql`。
- 当前假客户端测试验证了事务与 SQL 契约；发布前仍需用真实 PostgreSQL 完成迁移、回滚和并发集成测试。
