# 参与 ForgeX

感谢你愿意改进 ForgeX。我们欢迎缺陷修复、可访问性改进、文档、测试和经过讨论的新能力。

## 开始之前

1. 对安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。
2. 大型功能、协议或数据库变更请先创建设计讨论，说明用户旅程、信任边界和迁移策略。
3. 不得提交客户数据、访问令牌、私钥、Cookie、生产地址或其他秘密。

## 本地开发

需要 Node.js 22.13 或更高版本，推荐 Node.js 24 LTS。

<!-- AUTO-GENERATED: package.json scripts -->

| 命令                        | 用途                                   |
| --------------------------- | -------------------------------------- |
| `npm ci`                    | 按锁文件安装依赖。                     |
| `npm run format:check`      | 检查 Prettier 格式。                   |
| `npm run typecheck`         | 检查工作区和测试类型。                 |
| `npm test`                  | 运行 Vitest 测试。                     |
| `npm run test:coverage`     | 运行测试并检查覆盖率门禁。             |
| `npm run build:all`         | 构建 TypeScript 工作区和 Web Console。 |
| `npm run test:e2e`          | 运行默认 Playwright 浏览器测试。       |
| `npm run test:e2e:postgres` | 构建后运行真实 PostgreSQL 浏览器闭环。 |
| `npm run db:migrate`        | 校验并执行 PostgreSQL 顺序迁移。       |

<!-- END AUTO-GENERATED -->

提交前至少运行 `npm run format:check`、`npm run typecheck`、`npm run test:coverage` 和 `npm run build:all`。涉及浏览器旅程或 PostgreSQL 装配时，还要运行对应 E2E 命令。

修复缺陷和新增行为应先添加能够失败的回归测试，再提交最小实现。提交信息使用简体中文，技术标识符保持原样。

## Pull Request 要求

- 一个 PR 聚焦一个清晰目标，并写明用户影响和验证证据。
- 数据库变更只能增加新的顺序迁移，不得修改已发布迁移。
- API 与持久快照的不兼容变更必须提升 `schemaVersion` 并提供迁移说明。
- 新页面同时验证键盘操作、移动端、浅色与深色主题。
- 涉及认证、凭据、执行器、MCP、Git 或容器边界时，必须附威胁模型与负向测试。

提交贡献即表示你同意贡献按仓库的 Apache-2.0 许可证发布。
