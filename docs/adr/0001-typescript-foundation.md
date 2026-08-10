# ADR-0001：首版采用 TypeScript 工作区

## 状态

已接受。

## 决策

首版使用 TypeScript 工作区建设 Web、Control Plane、Worker 和共享契约。生产元数据目标为 PostgreSQL；首个 TDD 里程碑先实现纯领域模型。

## 原因

- 当前开发环境具备 Node.js 24，没有 Maven 和 Docker。
- Codex 官方 TypeScript SDK 适合服务端控制本地 Codex 线程。
- 单语言能够降低开源用户的启动和贡献门槛。

## 后果

当企业客户需要 Java 控制面时，通过稳定的 HTTP/Event/Artifact Contract 增加实现，不改变 Worker 协议和领域契约。
