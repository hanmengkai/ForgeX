# ForgeX

[简体中文](README.md) | [English](README.en.md)

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
3. Codex 登录留在客户设备本地，平台通过租约按团队实际规模调度任意数量账户并行工作。
4. CI 和独立 Runner 产生验证结论，Agent 不能自证通过。
5. 不可逆操作必须经过明确的人工审批。

## 系统结构

```text
产品与需求人员 -> Web Console -> Control Plane -> PostgreSQL
                                  |       |
                                  |       +-> 独立 Verification Runner
                                  +----------> 客户设备 Worker -> 本机 Codex / MCP
```

- `apps/web-console`：面向普通用户的 React 工作台。
- `apps/control-plane-api`：认证、需求、项目、调度、扩展和审计 API。
- `services/device-worker`：在客户设备上隔离运行 Codex，并保留本地凭据。
- `services/verification-runner`：从权威提交运行固定验证套件并发布 Preview。
- `services/extension-admin`：在受控管理员环境中发布和验证 Skill、MCP。
- `packages/*`：领域、应用、契约、扩展和 PostgreSQL 适配层。

## 本地验证

需要 Node.js 22.13 或更高版本，推荐使用当前 Node.js 24 LTS。

```bash
npm ci
npm run format:check
npm run typecheck
npm run test:coverage
npm run build:all
npm run test:e2e
npm run --workspace @forgex/web-console dev
```

真实 PostgreSQL 浏览器闭环还需要可用的 `FORGEX_TEST_DATABASE_URL`，且隔离测试数据库名称必须以 `_test` 结尾，然后运行 `npm run test:e2e:postgres`。完整命令说明见 [贡献指南](CONTRIBUTING.md)。

数据库迁移由带校验和账本和 PostgreSQL advisory lock 的统一命令执行，不要再逐个手工运行 SQL：

```bash
FORGEX_DATABASE_URL=postgresql://forgex:password@localhost:5432/forgex npm run db:migrate
```

## Docker Compose 本地部署

推荐直接使用 [Windows / Ubuntu 一键部署脚本与完整教程](docs/deployment/README.md)：

```powershell
deploy\windows\deploy.cmd
```

```bash
./deploy/ubuntu/deploy.sh
```

以下是等价的手工 Compose 装配步骤：

1. 复制 `deploy/.env.example` 为 `deploy/.env`，用 `openssl rand -hex 32` 生成 64 位十六进制数据库密码，并把同一个值分别写入 `FORGEX_POSTGRES_PASSWORD` 与已经 URL 编码的 `FORGEX_DATABASE_URL`。如使用其他字符集，必须先对 URL 用户信息部分做 percent-encoding，不能直接把原始密码拼进 URI。
2. 仅本机访问时，复制 `deploy/config/control-plane.example.json` 为 `deploy/config/control-plane.json`；该模板通过 `publicOrigin: http://localhost:8080` 明确限定浏览器回环访问，因此可以关闭 Secure Cookie。公开部署必须改用 `deploy/config/control-plane.production.example.json`，把 `publicOrigin` 替换为真实 HTTPS Origin，并在 Web 前配置 TLS 终止点；非回环 HTTP 或关闭 Secure Cookie 的配置会在启动时被拒绝。
3. 在 `deploy/.env` 设置 `FORGEX_BOOTSTRAP_ADMIN_USERNAME`、`FORGEX_BOOTSTRAP_ADMIN_NAME` 和至少 12 位的随机强密码 `FORGEX_BOOTSTRAP_ADMIN_PASSWORD`。它只在当前租户还没有任何平台账号时创建首个超级管理员；初始化完成后应从部署环境移除明文密码。`control-plane.json` 中的摘要令牌继续供受控的非浏览器客户端使用，人员令牌与 Runner 令牌不得复用。
4. 对最终的 `control-plane.json` 计算 SHA-256，并写入 `FORGEX_CONTROL_PLANE_CONFIG_SHA256`。Linux 可用 `sha256sum deploy/config/control-plane.json`，PowerShell 可用 `(Get-FileHash deploy/config/control-plane.json -Algorithm SHA256).Hash.ToLowerInvariant()`。任何授权配置变化都必须同步更新该摘要，并会立即令旧浏览器会话失效。
5. 从仓库根目录启动：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

Web Console 位于 `http://localhost:8080`，Control Plane 只在 Compose 内网暴露。迁移服务成功退出后 API 才会启动，Web 又会等待数据库就绪探针通过。公开部署必须让浏览器始终通过与 `publicOrigin` 完全一致的 HTTPS 地址访问，并把示例域名、标识、摘要和数据库密码全部替换；TLS 可以终止在 Web 前的可信反向代理，上游 Compose 内网仍可使用 HTTP。

## 标准项目初始化

平台管理员可以在“平台管理 / 客户与项目”中为项目启用 `standard-delivery@1`。初始化会写入租户与项目范围内的幂等台账，并展示三项后续工作：补充项目知识、安装并评测团队 Skill、连接并验证 MCP。`action_required` 表示仍需管理员配置，不代表初始化失败；系统不会复制 MCP 凭据，也不会自动启用本地连接。

## 可信 Skill 发布与激活

浏览器不持有扩展评测私钥。仓库提供独立的本地 `extension-admin`，由受控管理员身份生成 Ed25519 评测身份、把 `SKILL.md` 与 `references/`、`assets/` 下的 Markdown/纯文本/JSON 打成内容寻址制品，再按“发布、登记独立基线评测、激活”顺序提交控制面。脚本、二进制资源、越权权限和控制面明文凭据都会失败关闭。

先把管理员访问令牌放入只允许该管理员身份读取的文件，复制并填写 [bootstrap 示例](services/extension-admin/extension-admin.bootstrap.example.json)，再执行：

```bash
npm run --workspace @forgex/extension-admin build
npm run --workspace @forgex/extension-admin admin -- bootstrap \
  --input /private/extensions/extension-admin.bootstrap.json \
  --output /private/extensions
```

命令会生成两组彼此独立的 Skill 评测/MCP 探测私钥、`extension-admin.config.json`，以及不含管理员令牌和私钥的 `control-plane.extensions.json`。把公钥片段中的 `skillEvaluators`、`mcpVerifiers` 合并进控制面配置，更新 `FORGEX_CONTROL_PLANE_CONFIG_SHA256` 并重启控制面；私钥、管理员令牌和后续发布包不得提交 Git。

Skill 源码必须先复制到只允许扩展管理员身份访问的私有 staging 目录，目录中必须包含 `SKILL.md`；可选业务资料只放在 `references/` 或 `assets/`。`pack` 会逐项检查目录与文件的 owner、ACL/mode、非符号链接和读取前后身份，不能直接从团队共享、其他用户可写的工作树签名。复制 [发布输入示例](services/extension-admin/skill.release.example.json) 后，先离线生成一个稳定、可安全重试的发布包，再提交：

```bash
npm run --workspace @forgex/extension-admin admin -- pack \
  --config /private/extensions/extension-admin.config.json \
  --input /private/extensions/visitor-skill.release.json \
  --output /private/extensions/visitor-skill.bundle.json

npm run --workspace @forgex/extension-admin admin -- release \
  --config /private/extensions/extension-admin.config.json \
  --bundle /private/extensions/visitor-skill.bundle.json
```

`pack` 在任何网络请求前固定 `skillKey`、版本、制品摘要、评测标识和签名；响应丢失时必须重放同一个 bundle，不能重新打包。内置套件只证明规范编码、范围/摘要绑定、交付只读权限和安全文本资源这五项发布基线，不冒充业务效果评测。需要更强业务保证时应增加独立、版本化的可信评测器，不能把候选 Skill 自述当成通过证据。

## 可信 MCP 本地探测与启用

MCP 凭据和连接方式始终留在客户设备的私有配置中。复制并填写 [MCP 发布输入示例](services/extension-admin/mcp.release.example.json)，确保其中的 `connectionBindingKey` 与正式 Worker 私有配置里的对应连接完全一致。`mcp-pack` 会直接连接本地 MCP，读取真实 `initialize` 协商版本、服务身份、完整工具清单与输入 Schema；它不会调用任何工具。stdio 启动器、脚本和配置会按绝对路径、owner/ACL/mode 与 SHA-256 复验，远程连接只允许 HTTPS 或本机回环 HTTP，且禁止重定向。

```bash
npm run --workspace @forgex/extension-admin admin -- mcp-pack \
  --config /private/extensions/extension-admin.config.json \
  --input /private/extensions/team-notifications.mcp.json \
  --output /private/extensions/team-notifications.bundle.json

npm run --workspace @forgex/extension-admin admin -- mcp-release \
  --config /private/extensions/extension-admin.config.json \
  --bundle /private/extensions/team-notifications.bundle.json

# 至少每 24 小时前重新做一次真实只读探测并登记新证明
npm run --workspace @forgex/extension-admin admin -- mcp-health-pack \
  --config /private/extensions/extension-admin.config.json \
  --input /private/extensions/team-notifications.mcp.json \
  --source /private/extensions/team-notifications.bundle.json \
  --output /private/extensions/team-notifications.health.json

npm run --workspace @forgex/extension-admin admin -- mcp-health-release \
  --config /private/extensions/extension-admin.config.json \
  --bundle /private/extensions/team-notifications.health.json
```

生成的 bundle 不含 URL 请求头、环境变量、stdio 参数里的本地秘密或其他连接凭据，只包含业务清单、规范 Schema 和由独立 MCP 探测私钥签名的健康证明。发布命令严格按“发布清单与 Schema、登记健康证明、启用修订”执行；响应丢失时必须重放同一个 bundle，不能重新探测或重新生成标识。健康证明最多使用 24 小时；应在到期前定时执行 `mcp-health-pack` 与 `mcp-health-release`。前者先从控制面读取当前探测链头，再对同一受保护连接重新协商并精确核对原服务身份、协议和全部 Schema；后者普通续期只登记新证明，只有携带控制面熔断恢复挑战时才重新启用。健康续期响应丢失时同样重放稳定的 health bundle，已经持久化的完全相同证明即使后来超过新写时效也能幂等确认，新生成的过期证明仍会拒绝。第 2 版起必须在输入中沿用原 `serverKey` 与各 `toolKey`，从而保留可审计历史。服务身份是 MCP 协议自报信息，签名证明的是“受保护的本地连接在该时刻实际协商并暴露了这些能力”，不把它提升为第三方身份认证。控制面派发时会把该身份摘要和协议版本固化到任务信封，Worker 在向本地连接发送任何工具调用前必须用真实 `initialize` 结果精确复核，替换成同名同 Schema 的另一服务也会失败关闭。

## 独立验证 Runner

独立验证 Runner 使用受保护的本地会话、Ed25519 私钥和日志完整性密钥，从权威 Git 仓库取出精确提交，再在无网络、非 root、资源受限的 Docker 容器中运行固定套件。验证镜像必须使用 registry digest 或本机 `sha256:<image-id>` 固定，Docker 与 Git 程序也会在每次使用前核对本地 SHA-256；Runner 不执行仓库提供的 shell 字符串，也不会把容器错误原文或秘密写入普通日志。验证全部通过后，Runner 会从同一权威提交中读取计划精确绑定的产品 HTML，按普通文件、路径、大小、UTF-8 和自包含资源边界校验，再把原始字节作为内容寻址 Preview 发布。控制面只在无网络、无表单提交、无跳转、无同源权限的 sandbox iframe 中展示它。Runner 只证明 Preview 与已验证提交精确绑定且能安全打开，不用标签或候选脚本替用户断言“交互已通过”；产品负责人必须实际操作该页面后再验收，固定套件证据仍独立证明业务条件。

仓库随附一个真正可构建的最小独立验证镜像。它只读取只读候选工作树，检查锁文件、严格 TypeScript 基线、文件数量与大小、符号链接和敏感文件，不调用候选自己的 `npm scripts`。先构建镜像并记录内容寻址 ID：

镜像的 Node.js 基座同时固定了版本标签和 OCI manifest digest；更新基座时必须显式审查并同步包装测试，不能只改为另一个可漂移标签。

```bash
npm run --workspace @forgex/verification-runner build:verifier
docker image inspect forgex/repository-integrity:local --format '{{.Id}}'
```

这个镜像证明的是“候选仓库完整性”，不能自动证明任意业务验收条件。部署者只能把它映射到它实际覆盖的条件；业务行为必须由同样固化在受信镜像中的项目专用测试驱动验证，不能改回执行候选仓库的 `npm test`。

首次部署不再手工制作密钥、令牌摘要和 `planHash`。在 Runner 控制器身份的私有目录中复制并填写 [bootstrap 输入示例](services/verification-runner/runner.bootstrap.example.json)。Linux 的 `containerUser` 必须填写 Runner 控制器真实的非 root `id -u:id -g`，使容器只能读取该身份创建的只读工作树；不要照抄与宿主文件所有者不一致的 UID/GID。然后构建并运行管理命令：

```bash
npm run --workspace @forgex/verification-runner build
npm run --workspace @forgex/verification-runner admin -- bootstrap \
  --input /private/runner/runner.bootstrap.input.json \
  --output /private/runner
```

命令会原子生成会话、Ed25519 私钥、journal 完整性密钥、`runner.bootstrap.json` 和不含明文会话的 `control-plane.runner.json`。把后一个文件中的 `runnerSessions` 与 `trustedRunners` 条目合并进控制面的 `control-plane.json`，重新计算 `FORGEX_CONTROL_PLANE_CONFIG_SHA256` 并重启控制面。私钥和原始会话不得复制进控制面配置。

有交付候选后，用已授权的 Runner 会话读取实时 target：

```bash
npm run --workspace @forgex/verification-runner admin -- targets \
  --bootstrap /private/runner/runner.bootstrap.json
```

复制 [计划示例](services/verification-runner/runner.plan.example.json)，把其中的 requirement、revision、commit、criterion keys 和上一步得到的 target 精确对应，把 `image` 换成实际 registry digest 或本机 image ID，并确认 `preview.entryPath` 指向该提交内由设备生成的 `.forgex/preview.html`。该文件必须是自包含、可操作、无外链的单页 HTML；它用于产品效果验收，不能替代固定套件的独立证据。计划文件也必须放在私有目录。下面的命令会再次向控制面读取当前 target；任务、提交、Preview 入口或验收条件已经变化时会拒绝写配置，匹配时才计算完整 `planHash`：

```bash
npm run --workspace @forgex/verification-runner admin -- plan \
  --bootstrap /private/runner/runner.bootstrap.json \
  --plan /private/runner/runner.plan.json \
  --output /private/runner/runner.config.json
```

最后使用生成的配置启动。配置、会话、私钥、完整性密钥、计划和 journal 父目录必须只允许 Runner 控制器身份访问；Docker 应使用无特权运行身份，验证镜像必须预先拉取或构建，因为 Runner 固定使用 `--pull never`：

```bash
FORGEX_RUNNER_CONFIG=/private/runner/runner.config.json npm run --workspace @forgex/verification-runner start
```

## 客户设备 Worker

客户设备 Worker 使用本机 Codex 登录，不把 Codex 凭据上传控制面。默认的 `codexAuthentication.store=keyring` 要求每个 Codex 账户使用独立受限操作系统账号或容器和该隔离身份独占的空 `codexHomePath`；该目录不得出现 `auth.json`、个人 `config.toml`、第三方 MCP、Skills、Hooks 或插件。受控单机环境也可显式配置 `codexAuthentication: { "store": "file", "authFilePath": "/home/<user>/.codex/auth.json" }`，让包装器切换到已有登录的本机用户。启动器只把该用户独占的 `auth.json` 复制进单次临时 `CODEX_HOME`，任务结束后原子回写刷新结果，不加载个人配置或扩展；此模式无法再用操作系统权限证明该用户拥有的其他仓库不可读，安全性低于独立账号模式，应仅在设备所有者明确接受时使用。仓库随设备包交付 `forgex-codex-isolation-launcher`（构建产物为 `dist/isolation-launcher-main.js`），它在同一次 `--forgex-codex-run` 中先验证身份和文件边界，再调用固定版本的官方 `@openai/codex-sdk`；同控制器身份运行会直接失败。每次任务都把仓库标记为不可信，使仓库内 `.codex/config.toml` 不能扩展工具面。模型侧关闭通用 Shell、统一执行、图片读取、浏览器、桌面操作、应用、插件、记忆、Hooks、工作区依赖、网络和 Web 搜索，只保留内置 `apply_patch` 与 ForgeX 自带的只读工作树 MCP；启动前会读取真实 Codex CLI feature inventory，任何未分类的默认启用能力都会失败关闭，并用同一组运行参数读取真实 MCP inventory，要求唯一启用的服务及其命令、参数和工具白名单都与 ForgeX 可信清单完全一致。该 MCP 只提供有界的列目录、读普通业务文本和字面量搜索，不执行命令、不读取 `.git`、凭据文件、符号链接或工作树外路径。生产需用 root/管理员持有且其他用户不可写的 OS 包装器，在与 Worker 控制器不同的账号或容器内调用该 launcher。复制 [设备配置示例](services/device-worker/worker.config.example.json)，填入包装器路径与真实 SHA-256，再替换设备连接信息、项目与仓库标识以及本机绝对路径，然后执行：

```bash
npm run --workspace @forgex/device-worker build
FORGEX_WORKER_CONFIG=/absolute/path/worker.config.json npm run --workspace @forgex/device-worker start
```

首次接入时，管理员在 Web“设备中心”只签发十分钟有效的接入码，不会提前占用账户槽位，也不会在浏览器生成设备身份。设备侧先复制 [设备配置示例](services/device-worker/worker.config.example.json)，填入项目、仓库、本机绝对路径、设备能力、包装器路径与真实 SHA-256，并将其绝对路径设置为 `FORGEX_WORKER_CONFIG`；随后从仓库根目录执行页面给出的 `npm run --workspace @forgex/device-worker enroll -- --control-plane <控制面地址>`，按无回显提示粘贴接入码。CLI 会在配置同一私有目录原子生成并长期复用 `account.identity`，把显式能力与本地 MCP connection binding 一并登记，再原子写入正式 connection。同一 token 与 identity 的并发或响应丢失重试会返回完全相同的 session；token 到期后可由管理员重新签发，复用原 identity 只会安全轮换旧 session，不会占新槽位。配置、identity 和可选的 `--token-file` 都必须只允许 Worker 控制器身份读取且不得提交 Git；自动化使用 token 文件时，成功接入后 CLI 会删除它。

配置文件包含短期设备会话密钥，应限制为 Worker 控制器身份可读且不得提交 Git。`completionJournalPath` 的父目录必须预先创建，并与配置文件一样只允许控制器身份、Windows 的 `SYSTEM` 和管理员访问；隔离 Codex 身份不得读取这些路径。`codexHomePath` 则由隔离账号独占，控制器不读取。Worker 启动时会检查本地 ACL/mode、启动器及父目录不可被其他用户改写、启动器摘要和同一设备进程锁；每次任务还会重新验摘要，并让该启动器在同一隔离实例内完成文件探测和 SDK 执行，不能证明时不会产生 Codex 结果。Codex 只读取和编辑受控工作树，不能执行命令或写 `.git`；由可信 Worker 宿主检查分支、改动和疑似凭据后生成固定身份的本地提交，测试结论只接受独立 Runner 证据。完成意图和结果先通过文件与父目录同步（Windows 使用 write-through 原子移动）写入本地 journal，再以内容摘要绑定的幂等请求上报；进程或设备意外退出后可恢复，模型自由文本和自报测试不会上传。整个过程仍需独立 Runner 验证。

`mcpConnections` 只保存在客户设备的私有配置中。每条连接按控制面签发的 opaque `connectionBindingKey` 精确映射，`stdio` 启动器在 Worker 启动和每次调用前都核验普通文件、其他用户不可写的父目录与 SHA-256；解释器实际加载的脚本或配置文件必须使用 `trusted_file` 参数逐项声明绝对路径和 SHA-256，普通参数只允许不解释为路径或代码的受限值。远程连接只允许 HTTPS（本机回环可用 HTTP）且禁止重定向。设备在真实调用前重新核对工具白名单、输入 Schema、规范参数摘要和租约 fencing；凭据仅注入本地 MCP 进程或请求头，不进入控制面。非只读操作在调用前先写持久执行意图，崩溃后不会自动重做，而是进入“结果待人工核对”；只读操作才允许从同一意图安全重试。

Web Console 默认运行在 `http://localhost:4173`，并把 `/api` 转发到本机 `3000` 端口的 Control Plane。可复制 `apps/web-console/.env.example` 为本地 `.env` 设置项目名称、Agent 下载地址和仅限开发环境的会话 token；不要把生产凭据写进 Vite 环境变量。

## 当前已落地模块

- 需求控制面：版本化需求、确认审批、租户与项目隔离、分页和审计。
- 独立证据链：可信 Runner、公钥验签、交付候选绑定、内容寻址的同源 Preview 网关，以及验收快照。
- Codex 设备网关：账户数量不设产品上限，支持出站心跳、定向轮询、租约续期、fencing、重连回收和幂等完成。
- Codex 设备 Worker：使用官方 TypeScript Codex SDK，在仓库外独立 worktree 中执行已确认需求；仓库身份、需求版本、基线提交、新提交、分支和永久完成证明形成可恢复审计链，开发测试不能替代独立验收证据。
- 扩展控制面：按“业务资料、团队能力、外部工具”管理知识库、Skills 和 MCP 元数据，页面不暴露传输方式、凭据或内部标识。
- 项目标准交付初始化：用 `standard-delivery@1` 建立项目级初始化台账，逐项呈现知识、Skill 与 MCP 的就绪状态，并保留管理员、时间和幂等请求审计。
- 引用优先的业务知识库：需求分析师可发布和归档纯文本或 Markdown 资料，系统保留内容摘要与版本审计，并以带资料名、版本和段落的引用返回检索结果；资料内容始终按参考信息处理，不能覆盖平台指令或审批边界。
- 可信 Skill 发布：规范包、内容哈希、独立 Ed25519 评测、管理员激活、可验证回滚与 PostgreSQL 审计；退役公钥仅用于恢复历史状态。
- 可信 MCP 注册：设备本地连接绑定、独立 Ed25519 身份与能力探测、只读自动/变更确认策略、可验证回滚与 PostgreSQL 审计；页面不展示连接或工具编码。
- MCP 调用控制：内容寻址的输入 Schema、严格参数校验、只读自动排队、写入与外部动作由产品负责人确认，并把能力版本、参数摘要和审批记录固化到审计链；设备 Worker 已通过官方 MCP SDK 按本地连接精确执行并支持崩溃恢复，控制面不接收明文凭据。
- 共享持久化边界：测试/单机开发使用内存仓储；生产需求主线、审计、交付 outbox、Preview 制品和设备舰队均使用 PostgreSQL 事务仓储。
- 人性化 Web 工作台：使用业务语言展示需求状态、下一步和验收标准，支持录入用户故事与待澄清问题、修订完整规格、查看逐版差异，并由服务端 HATEOAS 与角色权限约束操作；设备中心可查看不限量账户、在线忙闲和当前交付，平台管理可维护客户、项目、多代码仓库及本地工作路径，并在浏览器本地生成 MCP 与外部工具发布配置。页面已覆盖桌面/移动端、明暗主题和键盘操作。

浏览器使用平台账号和密码调用同源会话入口；服务端以 `scrypt` 校验数据库中的盐值哈希，并交换为随机 opaque 会话。数据库不保存明文密码，只保存密码哈希、会话摘要、服务端到期时间和当前授权配置版本。返回的 `forgex_session` Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；除明确用于本机 HTTP 的配置外还必须启用 `Secure`。同一人员重新登录会撤销其旧会话，注销、服务端到期、账号修改或删除以及替换运行配置摘要都会让旧 Cookie 返回 401。Web 不把密码写入 `localStorage`、构建变量或普通日志，成功登录后立即清空输入；Cookie 写请求要求 `X-ForgeX-CSRF: 1`。超级管理员可在“平台管理 / 账号管理”中增删改查本租户所有账号，并为账号重置密码；系统会阻止停用或删除最后一个可用超级管理员。非浏览器客户端仍可使用 `Authorization: Bearer ...`。组织级 SSO 可在相同 `SessionAuthenticator` 边界接入。

生产接入前必须运行 `npm run db:migrate`。统一迁移器会按编号校验并执行从 [0001_worker_fleet.sql](packages/postgres/migrations/0001_worker_fleet.sql) 到 [0021_project_initializations.sql](packages/postgres/migrations/0021_project_initializations.sql) 的完整迁移链，禁止改写已登记迁移或跳过中间版本；Control Plane 的 readiness 也会核对名称与 SHA-256，不完整或漂移时返回 503。所有 API 副本必须连接同一数据库，并使用稳定且与设备端一致的 `projectKey`、`repositoryKey`。需求、Runner、Skill 与 MCP 的验证器必须保留历史公钥，并把退役密钥设置为仅核验历史记录。当前仍是预发布版本，不应直接用于生产交付。

当前完整顺序为 `0001_worker_fleet.sql`、`0002_requirement_control_plane.sql`、`0003_requirement_acceptance_audit.sql`、`0004_preview_artifacts.sql`、`0005_extension_catalog.sql`、`0006_skill_registry.sql`、`0007_mcp_registry.sql`、`0008_mcp_invocations.sql`、`0009_worker_work_kinds.sql`、`0010_knowledge_bases.sql`、`0011_delivery_runs.sql`、`0012_runner_verification.sql`、`0013_verification_failures.sql`、`0014_browser_sessions.sql`、`0015_worker_enrollments.sql`、`0016_requirement_revisions.sql`、`0017_delivery_skills.sql`、`0018_platform_accounts.sql`、`0019_platform_configuration.sql`、`0020_requirement_repository_context.sql`、`0021_project_initializations.sql`。生产装配共享 `PostgresWorkerFleetRepository`、`PostgresRequirementRepository`、`PostgresPreviewArtifactStore`、`PostgresExtensionCatalogRepository`、`PostgresSkillRegistryRepository`、`PostgresSkillArtifactStore`、`PostgresMcpRegistryRepository`、`PostgresMcpInputSchemaStore`、`PostgresMcpInvocationRepository`、`PostgresKnowledgeBaseRepository`、`PostgresAccountRepository`、`PostgresPlatformConfigurationRepository` 与 `PostgresProjectInitializationRepository`，并由 `PostgresBrowserSessionManager` 保存有界、可撤销的浏览器会话摘要，由 `PostgresWorkerEnrollmentManager` 保存短期且绑定设备身份的接入授权。

详细范围见 [产品章程](docs/product/PRODUCT_CHARTER.md) 和 [用户旅程](docs/product/USER_JOURNEYS.md)。参与贡献前请阅读 [贡献指南](CONTRIBUTING.md)、[安全政策](SECURITY.md) 和 [社区行为准则](CODE_OF_CONDUCT.md)。
