# ForgeX Deployment Guide

[简体中文](README.md) | [English](README.en.md)

This guide deploys, starts, and stops ForgeX on Windows 10/11 or Ubuntu with Docker Compose. The scripts manage only the `forgex` Compose project. They do not modify other host databases, Redis instances, containers, or neighboring projects.

> ForgeX `0.1.0` is a pre-release. The scripts provide a reproducible local or self-hosted baseline. A public service still needs a real domain, TLS, organizational identity, backups, monitoring, and environment-specific hardening.

## What the deployment script does

On first use, the script:

1. checks Docker Engine and Docker Compose v2;
2. creates the Git-ignored `deploy/.env` from `deploy/.env.example`;
3. generates the PostgreSQL password, initial administrator password, and UUIDs;
4. creates `deploy/config/control-plane.json` and records its SHA-256;
5. builds images, applies all ordered PostgreSQL migrations, and starts the stack;
6. waits for `http://127.0.0.1:<port>/healthz` to return `ok`.

Later deployment runs preserve existing secrets, identifiers, and the public origin. They validate the configuration, rebuild, migrate forward, and start the services.

## Prerequisites

### Windows

- 64-bit Windows 10 or 11.
- [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) running Linux containers.
- At least 4 GB assigned to Docker Desktop; 8 GB is recommended while building.
- A ForgeX source checkout and PowerShell or Command Prompt opened at the repository root.

### Ubuntu

- A 64-bit Ubuntu release supported by Docker.
- Docker Engine, Buildx, and the Compose plugin installed through the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
- A deployment account that can run `docker info`, plus `curl` and standard GNU tools.
- A ForgeX source checkout.

Verify both platforms before deployment:

```bash
docker info
docker compose version
```

## Windows

Run from the repository root:

```powershell
deploy\windows\deploy.cmd
```

You can also double-click `deploy\windows\deploy.cmd`; its window pauses so you can save the initial password. The default URL is `http://localhost:8080`.

The `.cmd` launchers always pause for an operator. Unattended automation should call `deploy.ps1`, `start.ps1`, or `stop.ps1` directly.

Public deployment requires an explicit HTTPS origin:

```powershell
deploy\windows\deploy.cmd -Mode production -PublicOrigin https://forgex.example.com -HttpPort 8080
```

<!-- AUTO-GENERATED: deploy/windows/deploy.ps1 -->

| Option           | Default                | Purpose                                                     |
| ---------------- | ---------------------- | ----------------------------------------------------------- |
| `-Mode`          | `local`                | `local` permits loopback HTTP; `production` requires HTTPS. |
| `-PublicOrigin`  | empty                  | Required in production, without a path.                     |
| `-HttpPort`      | `8080`                 | Host port for the Web service.                              |
| `-AdminUsername` | `super.admin`          | Initial administrator username.                             |
| `-AdminName`     | `ForgeX Administrator` | Initial administrator display name.                         |

<!-- END AUTO-GENERATED -->

Start and stop an existing deployment:

```powershell
deploy\windows\start.cmd
deploy\windows\stop.cmd
```

## Ubuntu

Run from the repository root:

```bash
chmod +x deploy/ubuntu/*.sh
./deploy/ubuntu/deploy.sh
```

The default URL is `http://localhost:8080`. Public deployment example:

```bash
./deploy/ubuntu/deploy.sh \
  --mode production \
  --public-origin https://forgex.example.com \
  --port 8080
```

<!-- AUTO-GENERATED: deploy/ubuntu/deploy.sh -->

| Option             | Default       | Purpose                                              |
| ------------------ | ------------- | ---------------------------------------------------- |
| `--mode`           | `local`       | Selects `local` or `production`.                     |
| `--public-origin`  | empty         | Required HTTPS origin in production, without a path. |
| `--port`           | `8080`        | Host port for the Web service.                       |
| `--admin-username` | `super.admin` | Initial administrator username.                      |
| `--admin-name`     | `超级管理员`  | Initial administrator display name.                  |

<!-- END AUTO-GENERATED -->

Lifecycle commands:

```bash
./deploy/ubuntu/start.sh
./deploy/ubuntu/stop.sh
```

Stop uses `docker compose stop`, so containers stop while the PostgreSQL volume remains intact. The scripts never use `docker compose down -v`.

## Generated private configuration

The first deployment creates two Git-ignored files:

- `deploy/.env` contains database and bootstrap secrets, the config digest, and the host port.
- `deploy/config/control-plane.json` contains runtime origins, identifiers, and controlled-client authorization digests.

After the first successful sign-in, change the administrator password and clear `FORGEX_BOOTSTRAP_ADMIN_PASSWORD` in `deploy/.env`. Never commit or share either private file.

If you intentionally change `control-plane.json`, recalculate its SHA-256 and update `FORGEX_CONTROL_PLANE_CONFIG_SHA256` in `deploy/.env`:

```powershell
(Get-FileHash deploy/config/control-plane.json -Algorithm SHA256).Hash.ToLowerInvariant()
```

```bash
sha256sum deploy/config/control-plane.json
```

Deployment and start scripts verify this digest before touching the Compose services.

## Health, status, and logs

```bash
curl http://127.0.0.1:8080/healthz
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml ps
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml logs --tail 200 web control-plane migrate postgres
```

For public deployments, `publicOrigin` must exactly match the HTTPS origin visible to the browser. TLS may terminate at a trusted reverse proxy in front of the Web service.

## Upgrade, backup, and rollback

Back up PostgreSQL and both private configuration files before an upgrade. With the default database and role on Ubuntu:

```bash
mkdir -p backups
docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml \
  exec -T postgres pg_dump -U forgex -d forgex \
  > "backups/forgex-$(date +%Y%m%d-%H%M%S).sql"
cp deploy/.env deploy/config/control-plane.json backups/
```

Windows PowerShell can preserve SQL output through `cmd.exe`:

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
cmd.exe /c "docker compose -p forgex --env-file deploy/.env -f deploy/compose.yaml exec -T postgres pg_dump -U forgex -d forgex > backups\forgex.sql"
Copy-Item deploy/.env,deploy/config/control-plane.json backups/
```

After updating the source, rerun the platform deployment script to rebuild and migrate forward. A source rollback must remain compatible with the current migration ledger. ForgeX does not automatically downgrade the database; validate backup restoration in an isolated environment before any production recovery.

## Troubleshooting

- **Docker unavailable:** start Docker Desktop on Windows or verify `systemctl status docker` and account permissions on Ubuntu.
- **Digest mismatch:** review the config change, recalculate SHA-256, and update `.env`; do not disable verification.
- **Port conflict:** choose an unused port on first deployment and keep it aligned with `publicOrigin`.
- **Health timeout:** inspect `docker compose ... ps` and `logs`; common causes are image pull failures, port conflicts, migration errors, or insufficient Docker resources.
- **Lost initial password:** it remains in the Git-ignored `.env` until an administrator clears it. Once an account exists, use the controlled password-reset flow instead of expecting bootstrap to overwrite it.
