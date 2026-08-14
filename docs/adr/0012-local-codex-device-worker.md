# ADR-0012：本地隔离的 Codex 设备 Worker

## 状态

已采纳，当前实现仍属于预发布版本。

## 背景

ForgeX 的控制面已经能够确认需求、生成权威派发记录，并按团队规模使用多个客户 Codex 账号对应的设备租约并行调度任务。但“设备领到任务”不等于“需求被真实实现”：设备还需要在正确仓库中创建隔离工作区，调用本机 Codex，形成可追溯提交，并把结果可靠地交回控制面。

OpenAI 官方把 [Codex SDK](https://developers.openai.com/codex/sdk/) 定位为在应用和自动化流程中以编程方式运行本地 Codex Agent 的接口；[App Server](https://developers.openai.com/codex/app-server/) 更适合富客户端集成，其中远程 WebSocket 传输仍标为实验能力。因此设备 Worker 使用 TypeScript Codex SDK，而不把 App Server WebSocket 暴露成生产远程执行协议。

## 决策

1. Codex 登录与凭据始终留在客户设备。控制面只签发 ForgeX Worker 会话，设备只通过出站 HTTPS 心跳、轮询、续租和上报结果，不接收入站远程 Shell。
2. 每个项目配置同时绑定 `projectKey` 与 `repositoryKey`。权威需求执行信封也携带同一仓库身份；两者不一致时，设备在创建 worktree 或启动 Codex 之前直接拒绝任务。
3. 每个任务使用独立 Git worktree 与唯一 `forgex/<project>/<assignment>` 分支。Worker 校验主仓库和 worktree 的真实路径、Git 根目录、基线完整提交摘要、分支归属、祖先关系与工作区清洁度。
4. `workspace-write` 只限制写入，不能作为读取隔离。仓库交付真实 `forgex-codex-isolation-launcher`，生产用 root/管理员持有的 OS 包装器在与 Worker 控制器不同的身份或容器内启动它；Worker 配置、journal 及凭据不能进入模型工具面。控制器只发起一次 `--forgex-codex-run`：同一 launcher 进程先确认自身身份不同、实际读写 worktree、实际拒绝声明的保护路径，再原地调用固定版本的官方 `@openai/codex-sdk`，最后回传与随机 challenge、workspace 和保护路径摘要绑定的结果；没有“先探测、后另起高权限进程”的第二条路径。Codex 固定使用 `workspace-write`、禁止网络与 Web 搜索、`approvalPolicy: never`，把当前仓库标记为不可信以拒绝项目级 `.codex/config.toml`。模型侧只启用受控 MCP 工具调用必需的 Code Mode Host，并关闭通用 Shell、统一执行、图片读取、浏览器、桌面操作、应用、插件、Skills、Hooks、记忆、工作区依赖和环境继承。启动器先运行实际 CLI feature inventory，要求 Code Mode Host 已启用、全部危险能力确实为关闭状态，并对其他任何未分类的非 removed 默认启用特性失败关闭；再用同一组运行参数读取实际 MCP inventory，要求唯一启用服务为 `forgex_workspace`，且命令、参数与四个允许工具精确匹配，从而拒绝系统或企业配置层夹带的额外 MCP。依据官方 [MCP 配置说明](https://learn.chatgpt.com/codex/extend/mcp)，该服务将 `default_tools_approval_mode` 固定为 `approve`，使非交互任务能调用已授权的有界工具，而不是在 `approvalPolicy: never` 下静默跳过写入。该 MCP 逐次校验 realpath，只允许有界列目录、读取普通业务文本、字面量搜索和 `write_workspace_file` 写入；写入只接受当前工作树内不超过 1 MiB 的 UTF-8 文本，逐级拒绝 `.git`、`.codex`、高置信凭据路径、符号链接和目录跳转，并以同目录临时文件同步后原子替换，仍不提供通用命令执行。依据官方[配置参考](https://developers.openai.com/codex/config-reference/)，默认认证进入隔离身份的系统 keyring。设备所有者明确接受安全降级时，可使用 `file` 模式让 launcher 切换到已有登录的本机用户：启动器验证该用户独占的 `auth.json`，只复制它到单次临时 `CODEX_HOME` 并原子回写刷新结果，不加载个人配置、MCP、Skills、Hooks、插件或历史。由于该用户通常能读取自己拥有的其他仓库，`file` 模式不再把这些仓库列为操作系统层不可读路径，而依靠关闭 Shell、真实工具清单和工作树 MCP 的 realpath 边界限制模型访问；独立身份加 keyring 仍是推荐的强隔离模式。
5. 官方[审批与安全说明](https://developers.openai.com/codex/agent-approvals-security/)明确 `workspace-write` 会保护 `.git` 及 worktree 解析出的 Git 目录，因此 Codex 只负责读取和编辑受控工作树。可信 Worker 宿主重新校验预期分支、暂存范围与疑似凭据，用固定身份、禁用 Hooks/GPG 的方式生成本地提交；模型自由文本和自报测试只留本机，不进入控制面结果，测试结论由独立 Runner 产生。
6. 完成上报绑定仓库、需求版本、租约 `assignmentKey`、单调 `fencingToken`、基线提交、新提交、分支与固定业务摘要，并计算完整 completion digest。控制面先验证当前租约和权威执行信封，再把同一 digest 写入 Worker 永久完成证明；证明已存在时也只允许完全相同的结果恢复，随后持久化交付结果并追加 `delivery.completed` 审计。
7. Worker 完成与需求结果属于两个持久仓储，不能假装成单事务。设备在宿主提交前以文件 fsync 加父目录 fsync 持久保存 commit intent，Windows 用 `MoveFileEx(..., MOVEFILE_WRITE_THROUGH)` 完成同等的原子替换；提交后升级为 completion journal。进程或设备意外退出后先续租，再按权威项目配置重算工作树路径和分支，恢复原提交而不重跑 Codex。完成请求可幂等重试，永久证明允许在租约墓碑淘汰后恢复；明确失效的旧结果会隔离而不会永久占用设备。
8. PostgreSQL 迁移 `0011_delivery_runs.sql` 为 outbox 补充仓库身份，并持久化内容寻址的交付运行结果、完成状态和查询索引。内存实现仅用于测试与单机开发。

隔离启动器是部署边界而不是可选优化。`--forgex-codex-run` 从标准输入读取版本、challenge、控制器身份、workspace、保护路径、Codex 配置、提示与输出 Schema；随仓库交付的实现负责在一个隔离实例内验证边界、启动 SDK 并返回结构化结果。控制器启动时校验 launcher/父目录 owner 与写 ACL、固定 SHA-256，每次执行前再次计算摘要。直接指向官方 Codex 二进制、仅靠提示词、与控制器同身份的包装脚本或只自报布尔值而未调用随仓库 launcher 的实现都无法通过该门。

## 结果

- 多台设备可以在不同仓库和独立 worktree 中并行实现需求，而不会共享可变工作区。
- 调用方不能用错误仓库、错误需求版本、错误分支或旧 fencing 伪造完成。
- 控制面重启、API 副本切换或结果最终审计短暂失败，不会丢失已经获得永久证明的交付结果。
- 产品验收仍然等待独立 Runner 对确切仓库提交和制品进行验证，设备 Codex 不能自证通过。

## 后续

- 增加真实 PostgreSQL 双连接并发与迁移集成测试。
- 增加独立 Runner 对 `repositoryKey + commitSha` 的取件、构建、测试和签名证据回传。
- 增加设备安装、升级、会话主动吊销与健康诊断的运维体验。
