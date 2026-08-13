# ForgeX 部署指南

[简体中文](README.md) | [English](README.en.md)

本文说明如何在 Windows 10/11 与 Ubuntu 上通过 Docker Compose 部署、启动和停止 ForgeX。脚本只管理 ForgeX 自己的 `forgex` Compose 项目，不操作宿主机上的其他数据库、Redis、容器或相邻项目。

> ForgeX 当前为 `0.1.0` 预发布版。默认脚本适合本机、内网验证和自托管装配；公网服务还必须由部署者配置域名、TLS、组织身份源、备份和监控。

## 部署结果

首次部署会自动完成以下工作：

1. 检查 Docker Engine 与 Docker Compose v2。
2. 从 `deploy/.env.example` 创建 Git 忽略的 `deploy/.env`。
3. 生成 PostgreSQL 密码、管理员初始密码和项目级 UUID。
4. 创建 `deploy/config/control-plane.json` 并写入 SHA-256 摘要。
5. 构建镜像，执行全部 PostgreSQL 顺序迁移，然后启动 Web、Control Plane 与 PostgreSQL。
6. 等待 `http://127.0.0.1:<port>/healthz` 返回 `ok`。

再次运行部署脚本时，既有密码、标识与公开地址会被保留，只重新校验配置、构建和启动服务。脚本不会覆盖现有配置。

## 准备工作

### Windows

- Windows 10/11 64 位。
- 安装并启动 [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux containers。
- 为 Docker Desktop 预留至少 4 GB 内存；构建阶段建议 8 GB。
- 获取 ForgeX 源码并在 PowerShell 或命令提示符中进入仓库根目录。

### Ubuntu

- 受 Docker 官方支持的 64 位 Ubuntu。
- 按 [Docker Engine for Ubuntu](https://docs.docker.com/engine/install/ubuntu/) 安装 Docker Engine、Buildx 和 Compose plugin。
- 当前账号能够执行 `docker info`；如需配置非 root 使用方式，请遵循 Docker 官方 Linux post-install 指南。
- 安装 `curl` 与标准 GNU 工具，并获取 ForgeX 源码。

部署前统一检查：

```bash
docker info
docker compose version
```

## Windows 一键部署

在仓库根目录运行：

```powershell
deploy\windows\deploy.cmd
```

也可以双击 `deploy\windows\deploy.cmd`；窗口会在结束时暂停，便于保存首次登录密码。默认地址为 `http://localhost:8080`。

`.cmd` 入口会固定暂停以便人工查看结果；无人值守自动化应直接调用同目录下的 `deploy.ps1`、`start.ps1` 或 `stop.ps1`。

公开部署必须提供真实 HTTPS Origin：

```powershell
deploy\windows\deploy.cmd -Mode production -PublicOrigin https://forgex.example.com -HttpPort 8080
```

<!-- AUTO-GENERATED: deploy/windows/deploy.ps1 -->

| 参数             | 默认值                 | 说明                                                          |
| ---------------- | ---------------------- | ------------------------------------------------------------- |
| `-Mode`          | `local`                | `local` 仅允许回环 HTTP；`production` 强制 HTTPS Origin。     |
| `-PublicOrigin`  | 空                     | 公开模式必填，例如 `https://forgex.example.com`，不能带路径。 |
| `-HttpPort`      | `8080`                 | Web 暴露到宿主机的端口。                                      |
| `-AdminUsername` | `super.admin`          | 首个管理员用户名，仅允许字母、数字、点、下划线和连字符。      |
| `-AdminName`     | `ForgeX Administrator` | 首个管理员显示名。                                            |

<!-- END AUTO-GENERATED -->

生命周期命令：

```powershell
# 启动或恢复现有服务
deploy\windows\start.cmd

# 停止服务，保留 PostgreSQL 数据卷
deploy\windows\stop.cmd
```

## Ubuntu 一键部署

从仓库根目录运行：

```bash
chmod +x deploy/ubuntu/*.sh
./deploy/ubuntu/deploy.sh
```

默认地址为 `http://localhost:8080`。公开部署示例：

```bash
./deploy/ubuntu/deploy.sh \
  --mode production \
  --public-origin https://forgex.example.com \
  --port 8080
```

<!-- AUTO-GENERATED: deploy/ubuntu/deploy.sh -->

| 参数               | 默认值        | 说明                                      |
| ------------------ | ------------- | ----------------------------------------- |
| `--mode`           | `local`       | `local` 或 `production`。                 |
| `--public-origin`  | 空            | 公开模式必填的 HTTPS Origin，不能带路径。 |
| `--port`           | `8080`        | Web 暴露到宿主机的端口。                  |
| `--admin-username` | `super.admin` | 首个管理员用户名。                        |
| `--admin-name`     | `超级管理员`  | 首个管理员显示名。                        |

<!-- END AUTO-GENERATED -->

生命周期命令：

```bash
# 启动或恢复现有服务
./deploy/ubuntu/start.sh

# 停止服务，等价于 docker compose stop，保留 PostgreSQL 数据卷
./deploy/ubuntu/stop.sh
```

## 自动生成的配置

以下文件包含部署凭据或授权信息，已被 Git 忽略：

- `deploy/.env`：数据库密码、管理员 bootstrap 密码、配置摘要和端口。
- `deploy/config/control-plane.json`：运行地址、租户/项目标识和受控客户端授权摘要。

<!-- AUTO-GENERATED: deploy/.env.example -->

| 变量                                 | 必需     | 用途                                           |
| ------------------------------------ | -------- | ---------------------------------------------- |
| `FORGEX_POSTGRES_DB`                 | 否       | PostgreSQL 数据库名，默认 `forgex`。           |
| `FORGEX_POSTGRES_USER`               | 否       | PostgreSQL 用户，默认 `forgex`。               |
| `FORGEX_POSTGRES_PASSWORD`           | 是       | 自动生成的数据库密码。                         |
| `FORGEX_DATABASE_URL`                | 是       | 迁移器与 Control Plane 使用的 PostgreSQL URL。 |
| `FORGEX_CONTROL_PLANE_CONFIG_SHA256` | 是       | `control-plane.json` 的 SHA-256。              |
| `FORGEX_BOOTSTRAP_ADMIN_USERNAME`    | 首次部署 | 首个管理员用户名。                             |
| `FORGEX_BOOTSTRAP_ADMIN_NAME`        | 否       | 首个管理员显示名。                             |
| `FORGEX_BOOTSTRAP_ADMIN_PASSWORD`    | 首次部署 | 自动生成的管理员初始密码。                     |
| `FORGEX_HTTP_PORT`                   | 否       | Web 宿主机端口，默认 `8080`。                  |
| `VITE_FORGEX_PROJECT_NAME`           | 否       | Web 中显示的默认项目名。                       |
| `VITE_FORGEX_AGENT_DOWNLOAD_URL`     | 否       | Web 中显示的设备包下载地址。                   |

<!-- END AUTO-GENERATED -->

首次成功登录后应立即修改管理员密码，并清空 `deploy/.env` 中 `FORGEX_BOOTSTRAP_ADMIN_PASSWORD` 的值。不要提交、发送或粘贴这两个私有配置文件。

手工修改 `control-plane.json` 后，必须同步更新摘要：

```powershell
# Windows：把输出值写回 deploy/.env
(Get-FileHash deploy/config/control-plane.json -Algorithm SHA256).Hash.ToLowerInvariant()
```

```bash
# Ubuntu：把输出值写回 deploy/.env
sha256sum deploy/config/control-plane.json
```

启动与部署脚本会在接触容器前复核该摘要；不一致时失败关闭。

## 验证、状态和日志

浏览器验证：

```text
http://localhost:8080
```

健康检查与容器状态：

```bash
curl http://127.0.0.1:8080/healthz
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml ps
```

查看最近日志：

```bash
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml logs --tail 200 web control-plane migrate postgres
```

公开模式的 `publicOrigin` 必须与浏览器实际访问的 HTTPS Origin 完全一致。TLS 可以终止在 Web 前的可信反向代理，但浏览器不得绕过该公开地址访问。

## 升级、备份与回滚

升级前先备份数据库和两个私有配置文件，并确认备份可读。默认数据库名和用户均为 `forgex`；如已修改，请替换命令中的值。

Ubuntu PostgreSQL 逻辑备份示例：

```bash
mkdir -p backups
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml \
  exec -T postgres pg_dump -U forgex -d forgex \
  > "backups/forgex-$(date +%Y%m%d-%H%M%S).sql"
cp deploy/.env deploy/config/control-plane.json backups/
```

Windows PowerShell 可创建目录后，通过 `cmd.exe` 保持 SQL 输出编码：

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
cmd.exe /c "docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml exec -T postgres pg_dump -U forgex -d forgex > backups\forgex.sql"
Copy-Item deploy/.env,deploy/config/control-plane.json backups/
```

拉取或解压新版本后，再次运行对应平台的部署脚本即可重新构建并执行向前迁移。例行停止只使用脚本中的 `docker compose stop`；不要为“停止服务”执行 `docker compose down -v`，后者会请求删除数据卷。

代码回滚必须选择与当前数据库迁移兼容的版本并重新运行部署脚本。ForgeX 不自动执行数据库降级；如新迁移不向后兼容，应在隔离环境验证备份恢复流程后，由管理员按变更方案恢复数据库。不要直接在唯一生产库上试验恢复。

## 常见问题

### Docker 不可用

- Windows：确认 Docker Desktop 已启动且使用 Linux containers。
- Ubuntu：确认 `systemctl status docker` 正常，并且当前账号可执行 `docker info`。

### 配置摘要不一致

说明 `control-plane.json` 在首次部署后发生了变化。确认变更可信，再重新计算 SHA-256 并更新 `deploy/.env`；不要直接关闭摘要检查。

### 端口被占用

首次部署时通过 `-HttpPort` 或 `--port` 选择空闲端口。已有部署应同时审查 `.env` 与 `publicOrigin`，不要只改端口后跳过摘要更新。

### 健康检查超时

先运行上面的 `docker compose ... ps` 和 `logs` 命令。常见原因包括镜像拉取失败、端口冲突、配置摘要错误、迁移失败或 Docker 资源不足。不要在未查明原因时删除 PostgreSQL 卷。

### 忘记初始管理员密码

首次部署输出的密码也保存在 Git 忽略的 `deploy/.env` 中，直到管理员主动清空。若首个管理员已经创建，重复填写 bootstrap 密码不会覆盖现有账号；应使用平台内的受控重置流程。
