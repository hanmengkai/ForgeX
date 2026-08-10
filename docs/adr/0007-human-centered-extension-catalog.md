# ADR-0007：扩展能力先以业务目录呈现

## 背景

ForgeX 需要同时管理项目知识、团队 Skills 和 MCP 工具。直接把文件路径、技术标识、传输方式和连接地址展示给产品经理或初级研发，会把平台变成只有管理员才能使用的配置面板，也会放大凭据泄露和误授权风险。

MCP 官方把能力分为 resources、tools 和 prompts，并明确工具调用应由用户批准。最新 TypeScript SDK 把 server、client 和 Fastify 等中间件拆成独立包，中间件只负责传输适配，不承载业务逻辑。参考：[MCP Server 指南](https://modelcontextprotocol.io/docs/develop/build-server)、[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

## 决策

- 页面固定使用“业务资料、团队能力、外部工具”三类名称，对应内部的知识库、Skills 和 MCP。
- 扩展定义从第一版开始连续发布；同一版本不可覆盖，租户、项目、类型和名称都由运行时契约校验。
- 页面只显示业务名称、用途、状态和质量信息。UUID 只存在于不展示的资源链接中；MCP 的 `stdio` / Streamable HTTP、连接地址、会话和凭据不进入 people view。
- 每个项目每类最多 100 项，避免无分页目录形成无界响应。
- MCP 领域策略和业务动作独立于 SDK。stdio 用于客户设备上的本地连接，远程连接使用 Streamable HTTP；两者只在适配层实现。
- 裸 `execute_sql()`、`run_shell()`、`kubectl()` 不得作为业务目录名称或直接开放给 Agent。后续网关只注册诸如“读取项目结构”“创建交付分支”“运行验收检查”这样的语义动作。

## 后果

- 扩展中心可以先稳定管理和审计能力，再分别接入知识索引、Skill 包和 MCP Gateway。
- 扩展元数据可进入 PostgreSQL；知识正文、Skill 资源、第三方 token 和客户连接配置使用各自的受控存储，不塞进目录 JSON。
- SDK 升级只影响边界适配器，不改变多租户授权和页面契约。
