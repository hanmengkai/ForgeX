import type { FastifyInstance, FastifyServerOptions } from "fastify";

import { EvidenceAuthority } from "@forgex/domain";
import {
  McpHealthAuthority,
  SkillEvaluationAuthority,
} from "@forgex/extensions";
import {
  assertPostgresMigrationsCurrent,
  PostgresExtensionCatalogRepository,
  PostgresKnowledgeBaseRepository,
  PostgresMcpInputSchemaStore,
  PostgresMcpInvocationRepository,
  PostgresMcpRegistryRepository,
  PostgresPreviewArtifactStore,
  PostgresRequirementRepository,
  PostgresSkillArtifactStore,
  PostgresSkillRegistryRepository,
  PostgresWorkerFleetRepository,
  type PostgresPool,
  type PostgresMigration,
  type PostgresQueryResult,
} from "@forgex/postgres";

import { buildControlPlaneApi } from "./index.js";
import { PostgresBrowserSessionManager } from "./postgres-browser-session.js";
import { PostgresWorkerEnrollmentManager } from "./postgres-worker-enrollment.js";
import {
  HashedRunnerSessionAuthenticator,
  HashedSessionAuthenticator,
  type ControlPlaneRuntimeConfig,
} from "./runtime-config.js";

export interface ProductionPostgresPool extends PostgresPool {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

export interface ProductionControlPlaneOptions {
  config: ControlPlaneRuntimeConfig;
  authRealmRevision: string;
  pool: ProductionPostgresPool;
  migrations: readonly PostgresMigration[];
  serviceVersion?: string;
  logger?: FastifyServerOptions["logger"];
}

export const createProductionControlPlane = (
  options: ProductionControlPlaneOptions,
): FastifyInstance => {
  const evidenceAuthority = new EvidenceAuthority({
    runners: options.config.trustedRunners,
  });
  const skillEvaluationAuthority = new SkillEvaluationAuthority({
    evaluators: options.config.skillEvaluators,
  });
  const mcpHealthAuthority = new McpHealthAuthority({
    verifiers: options.config.mcpVerifiers,
  });

  return buildControlPlaneApi({
    authenticator: new HashedSessionAuthenticator(options.config.sessions),
    browserSessionManager: new PostgresBrowserSessionManager(options.pool, {
      projectKey: options.config.projectKey,
      repositoryKey: options.config.repositoryKey,
      authRealmRevision: options.authRealmRevision,
    }),
    workerEnrollmentManager: new PostgresWorkerEnrollmentManager(options.pool, {
      projectKey: options.config.projectKey,
      repositoryKey: options.config.repositoryKey,
      authRealmRevision: options.authRealmRevision,
    }),
    runnerAuthenticator: new HashedRunnerSessionAuthenticator(
      options.config.runnerSessions,
    ),
    evidenceAuthority,
    extensionCatalogRepository: new PostgresExtensionCatalogRepository(
      options.pool,
    ),
    knowledgeBaseRepository: new PostgresKnowledgeBaseRepository(options.pool),
    mcpHealthAuthority,
    mcpInputSchemaStore: new PostgresMcpInputSchemaStore(options.pool),
    mcpInvocationRepository: new PostgresMcpInvocationRepository(options.pool),
    mcpRegistryRepository: new PostgresMcpRegistryRepository(options.pool),
    previewArtifactStore: new PostgresPreviewArtifactStore(options.pool),
    projectKey: options.config.projectKey,
    repositoryKey: options.config.repositoryKey,
    sessionCookieSecure: options.config.sessionCookieSecure,
    sessionCookieMaxAgeSeconds: options.config.sessionCookieMaxAgeSeconds,
    requirementRepository: new PostgresRequirementRepository(options.pool, {
      evidenceAuthority,
    }),
    skillArtifactStore: new PostgresSkillArtifactStore(options.pool),
    skillEvaluationAuthority,
    skillRegistryRepository: new PostgresSkillRegistryRepository(options.pool),
    workerFleetRepository: new PostgresWorkerFleetRepository(options.pool),
    readiness: async () => {
      await assertPostgresMigrationsCurrent(options.pool, options.migrations);
    },
    ...(options.serviceVersion
      ? { serviceVersion: options.serviceVersion }
      : {}),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
};
