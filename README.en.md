# ForgeX

[简体中文](README.md) | [English](README.en.md)

ForgeX is an open-source control plane for AI-assisted software delivery. It turns requirement clarification, solution design, implementation, verification, previews, and human approvals into a traceable delivery workflow. It can also coordinate multiple customer-owned devices, each using its own local Codex login, to work in parallel.

> Status: `0.1.0` pre-release. The repository includes a persistent control plane, a web console, customer-device workers, an independent verification runner, and a complete local Docker Compose setup. Before exposing ForgeX publicly, deployers must provide organizational identity, TLS, backups, monitoring, and environment-specific hardening.

## Who it is for

- Product managers who need a clear view of progress, outcomes, risks, and pending decisions.
- Requirements analysts who manage requirement revisions, clarification questions, and acceptance criteria.
- Junior developers who need to understand tasks, inspect changes and evidence, and take over when necessary.
- Platform administrators who manage customers, projects, repositories, accounts, trusted extensions, and worker enrollment.

The default UI uses business language and actionable next steps. Internal IDs, protocol fields, and low-level logs remain available in drill-down technical views instead of overwhelming regular users.

## Core principles

1. The requirement, not the chat transcript, is the delivery system of record.
2. Every stage produces structured, versioned artifacts.
3. Codex credentials stay on customer-owned devices.
4. CI and independent runners produce verification evidence; an agent cannot approve its own work.
5. Irreversible actions require explicit human approval.
6. Persistent objects, external APIs, and artifacts are versioned and fail with readable errors.

## Architecture

```text
Product and requirements users -> Web Console -> Control Plane -> PostgreSQL
                                                   |       |
                                                   |       +-> Independent Verification Runner
                                                   +----------> Customer Device Worker -> Local Codex / MCP
```

| Component                      | Responsibility                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `apps/web-console`             | React workbench for business users and platform administrators.                              |
| `apps/control-plane-api`       | Authentication, requirements, projects, scheduling, extensions, and audit APIs.              |
| `services/device-worker`       | Runs Codex in an isolated local identity while keeping credentials on the customer device.   |
| `services/verification-runner` | Checks an authoritative commit with pinned suites and publishes a content-addressed preview. |
| `services/extension-admin`     | Packages, signs, probes, and releases trusted Skills and MCP metadata.                       |
| `packages/*`                   | Domain, application, contract, extension, and PostgreSQL adapters.                           |

## Requirements

- Node.js `>=22.13.0`; the current Node.js 24 LTS is recommended.
- npm with the committed lock file.
- Docker and Docker Compose for the full local stack and verification image.
- PostgreSQL 17 for production-like integration and E2E testing.

## Quick start

```bash
npm ci
npm run format:check
npm run typecheck
npm run test:coverage
npm run build:all
npm run --workspace @forgex/web-console dev
```

The Vite development server runs at `http://localhost:4173` and proxies `/api` to a Control Plane on port `3000`. Copy `apps/web-console/.env.example` to a local `.env` only when you need to override development settings. Never put production credentials in Vite environment variables.

<!-- AUTO-GENERATED: package.json scripts -->

| Command                     | Purpose                                                                           |
| --------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`             | Build the TypeScript project references.                                          |
| `npm run build:all`         | Build the TypeScript workspaces and Web Console.                                  |
| `npm run db:migrate`        | Build the PostgreSQL package, verify the ledger, and apply sequential migrations. |
| `npm test`                  | Run the Vitest suite.                                                             |
| `npm run test:coverage`     | Run Vitest with coverage gates.                                                   |
| `npm run typecheck`         | Type-check workspaces and test sources.                                           |
| `npm run format:check`      | Check repository formatting with Prettier.                                        |
| `npm run test:e2e`          | Run the default Playwright browser journeys.                                      |
| `npm run test:e2e:postgres` | Build and run the real-PostgreSQL browser workflow.                               |

<!-- END AUTO-GENERATED -->

For the PostgreSQL E2E suite, provide a dedicated database through `FORGEX_TEST_DATABASE_URL`; its database name must end in `_test`. Do not point tests at a shared or production database.

## Local Docker Compose deployment

The recommended path is the [Windows and Ubuntu one-command deployment guide](docs/deployment/README.en.md):

```powershell
deploy\windows\deploy.cmd
```

```bash
./deploy/ubuntu/deploy.sh
```

The manual Compose equivalent follows:

1. Copy `deploy/.env.example` to `deploy/.env`.
2. Generate a 64-character hexadecimal PostgreSQL password with `openssl rand -hex 32`. Put the same value in `FORGEX_POSTGRES_PASSWORD` and the URL-encoded `FORGEX_DATABASE_URL`.
3. For loopback-only use, copy `deploy/config/control-plane.example.json` to `deploy/config/control-plane.json`. For any public deployment, start from `control-plane.production.example.json`, use the real HTTPS origin, and terminate TLS in front of the Web service.
4. Set the bootstrap administrator username, display name, and a random password of at least 12 characters. Remove the plaintext bootstrap password from the deployment environment after the first administrator is created.
5. Calculate the SHA-256 of the final `control-plane.json` and set `FORGEX_CONTROL_PLANE_CONFIG_SHA256`.
6. Start the stack from the repository root:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up --build
```

The Web Console is available at `http://localhost:8080`. The Control Plane is exposed only inside the Compose network. The migration container must complete successfully before the API starts, and the Web service waits for API readiness.

<!-- AUTO-GENERATED: deploy/.env.example -->

| Variable                             | Required    | Purpose                                                                            |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `FORGEX_POSTGRES_DB`                 | No          | PostgreSQL database name; defaults to `forgex`.                                    |
| `FORGEX_POSTGRES_USER`               | No          | PostgreSQL role; defaults to `forgex`.                                             |
| `FORGEX_POSTGRES_PASSWORD`           | Yes         | Random database password. Never commit the real value.                             |
| `FORGEX_DATABASE_URL`                | Yes         | URL-encoded PostgreSQL connection string used by migrations and the Control Plane. |
| `FORGEX_CONTROL_PLANE_CONFIG_SHA256` | Yes         | SHA-256 of the mounted authorization configuration.                                |
| `FORGEX_BOOTSTRAP_ADMIN_USERNAME`    | First setup | Username for the first tenant administrator.                                       |
| `FORGEX_BOOTSTRAP_ADMIN_NAME`        | No          | Display name for the first administrator.                                          |
| `FORGEX_BOOTSTRAP_ADMIN_PASSWORD`    | First setup | Random bootstrap password with at least 12 characters.                             |
| `FORGEX_HTTP_PORT`                   | No          | Host port for the Web service; defaults to `8080`.                                 |
| `VITE_FORGEX_PROJECT_NAME`           | No          | Default project label embedded in the Web build.                                   |
| `VITE_FORGEX_AGENT_DOWNLOAD_URL`     | No          | Device package download URL shown by the Web Console.                              |

<!-- END AUTO-GENERATED -->

Production deployments must use an HTTPS `publicOrigin` that exactly matches the browser-visible origin and must keep secure cookies enabled. Non-loopback HTTP configurations and insecure production cookies are rejected at startup. Replace every example identifier, digest, domain, token, and password before use.

## Standard project initialization

Platform administrators can initialize a project with `standard-delivery@1` from **Platform Management / Customers and Projects**. ForgeX records an idempotent, tenant-scoped initialization ledger and then reports three project-level readiness tasks:

- add project rules and domain knowledge;
- install and independently evaluate team Skills;
- connect and verify external MCP tools.

An `action_required` result means administrator setup is still needed; it is not an initialization failure. ForgeX never copies MCP credentials into the control plane and never enables a local connection merely because a preset was selected.

## Trust and execution boundaries

### Trusted Skills

The browser never holds evaluator private keys. The local `extension-admin` tool packages `SKILL.md` and permitted text assets into content-addressed artifacts, signs them with a protected Ed25519 identity, registers independent evaluation evidence, and activates them in separate steps. Scripts, binaries, excessive permissions, symlinks, and plaintext control-plane credentials fail closed.

Use the examples in `services/extension-admin/` to bootstrap the administrator identity and create stable bundles. If a response is lost, replay the same bundle; do not repackage it with new identifiers. Private keys, administrator tokens, staging inputs, and release bundles must never be committed.

### Trusted MCP metadata and invocation

MCP credentials and connection details remain in private worker configuration. `mcp-pack` connects to the protected local server, performs a real `initialize` handshake, and records the negotiated protocol, server identity, tool list, and input schemas without invoking any tool. Remote connections require HTTPS, except for loopback HTTP, and redirects are rejected.

Health evidence is short-lived and must be renewed before its 24-hour limit. The control plane can automatically queue read-only calls, while writes and external side effects require product-owner approval. A worker revalidates the live MCP identity, protocol, schema, normalized arguments, and lease fencing immediately before execution.

### Independent verification runner

The runner checks out the exact authoritative Git commit and executes a pinned suite in a non-root, resource-limited, network-disabled container. Images must be pinned by registry digest or local `sha256:<image-id>`. The runner does not execute repository-provided shell strings and does not treat candidate-authored claims as evidence.

After verification, it can publish a content-addressed, self-contained HTML preview from the same commit. The control plane renders that preview in a sandbox without network access, form submission, navigation, or same-origin privileges. The runner proves commit and preview binding; a product owner still performs the final product acceptance.

Build the bundled repository-integrity verifier with:

```bash
npm run --workspace @forgex/verification-runner build:verifier
docker image inspect forgex/repository-integrity:local --format '{{.Id}}'
```

### Customer-device worker

Each worker uses a local Codex login and an isolated operating-system identity or container. Codex credentials, local MCP credentials, session secrets, and completion journals remain on the customer device. The control plane stores only account display information, irreversible fingerprints, capabilities, and online state.

The ForgeX isolation launcher verifies identity, file ownership, ACL/mode, launcher digest, Codex feature inventory, MCP inventory, and tool allowlists before each run. Codex receives a bounded worktree editing surface and cannot write `.git`, run a general shell, browse the web, or read customer secrets. A trusted worker host creates the local commit, while independent runner evidence remains required for acceptance.

Enrollment codes are issued by an administrator in **Device Center**, expire after ten minutes, and do not consume an account slot until exchange succeeds. Copy `services/device-worker/worker.config.example.json` to a private location and then run:

```bash
npm run --workspace @forgex/device-worker enroll -- --control-plane <control-plane-origin>
FORGEX_WORKER_CONFIG=/absolute/path/worker.config.json npm run --workspace @forgex/device-worker start
```

Worker configuration, identity, token files, and journals must be readable only by the worker controller identity and must never be committed.

## Implemented modules

- Versioned requirement control plane with clarification, confirmation, revisions, acceptance criteria, pagination, tenant/project isolation, and audit.
- Standard project initialization with an idempotent `standard-delivery@1` ledger and Knowledge/Skill/MCP readiness tasks.
- Persistent customer, project, multi-repository, account, and local path management.
- Human-friendly responsive Web Console with keyboard support, light/dark themes, HATEOAS-constrained actions, and technical drill-down views.
- Unlimited worker fleet scheduling with heartbeat, directed polling, lease renewal, fencing, reconnection recovery, and idempotent completion.
- Independent signed evidence, delivery-candidate binding, content-addressed same-origin previews, and acceptance snapshots.
- Citation-first versioned knowledge bases for Markdown and plain-text business material.
- Trusted Skill and MCP registries with signed evaluations, health evidence, activation, rollback, and PostgreSQL audit.
- MCP invocation governance with schema validation, normalized argument digests, read-only automation, approval for side effects, and crash recovery.
- PostgreSQL transactional storage for requirements, audits, outbox delivery, previews, browser sessions, enrollments, extensions, and project initialization.

## Authentication and browser security

Browser users sign in with platform accounts. The server verifies salted `scrypt` password hashes and exchanges them for random opaque sessions. The database stores no plaintext passwords or cookies. The `forgex_session` cookie uses `HttpOnly`, `SameSite=Strict`, and `Path=/`, plus `Secure` outside explicit loopback development. State-changing cookie requests require `X-ForgeX-CSRF: 1`.

Logging in again revokes the user's previous session. Logout, server-side expiry, account updates or deletion, and authorization-config changes also invalidate old cookies. Non-browser clients may use controlled bearer tokens. Organizational SSO can be integrated at the same `SessionAuthenticator` boundary.

## Database migrations

Run `npm run db:migrate` before connecting a production-like Control Plane. The migrator verifies names and SHA-256 digests, serializes execution with a PostgreSQL advisory lock, and records a migration ledger. Never edit an applied migration or skip an intermediate version.

The current chain runs from [`0001_worker_fleet.sql`](packages/postgres/migrations/0001_worker_fleet.sql) through [`0021_project_initializations.sql`](packages/postgres/migrations/0021_project_initializations.sql). Readiness returns `503` if the database ledger is incomplete or has drifted.

## Contributing and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); never post credentials or exploitable details in a public issue.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- The current product scope is documented in the [Product Charter](docs/product/PRODUCT_CHARTER.md) and [User Journeys](docs/product/USER_JOURNEYS.md) (currently in Simplified Chinese).

Bug fixes and new behavior should start with a failing regression test. Database changes must add a new ordered migration. Breaking API or persisted-artifact changes require a version bump and migration notes.

## License

ForgeX is licensed under the [Apache License 2.0](LICENSE).
