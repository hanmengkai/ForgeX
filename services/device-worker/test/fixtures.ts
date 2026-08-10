import { DeviceWorkerConfigSchema } from "../src/config.js";
import { RequirementWorkerAssignmentSchema } from "../src/control-plane-client.js";

export const tenantKey = "11111111-1111-4111-8111-111111111111";
export const projectKey = "22222222-2222-4222-8222-222222222222";
export const repositoryKey = "66666666-6666-4666-8666-666666666666";
export const requirementKey = "33333333-3333-4333-8333-333333333333";
export const assignmentKey = "44444444-4444-4444-8444-444444444444";

export const requirementAssignment = RequirementWorkerAssignmentSchema.parse({
  workKind: "requirement_delivery",
  assignmentKey,
  fencingToken: 7,
  projectKey,
  requirementKey,
  requirementRevision: 1,
  title: "访客预约",
  leasedUntil: "2026-08-10T10:01:00.000Z",
  execution: {
    schemaVersion: 1,
    taskType: "requirement_delivery",
    projectKey,
    repositoryKey,
    requirementKey,
    requirementRevision: 1,
    spec: {
      schemaVersion: 1,
      title: "访客预约",
      goal: "让访客到访过程更顺畅",
      userStories: [],
      acceptanceCriteria: [
        {
          title: "访客可以提交预约",
          description: "填写完整信息后能够提交",
          priority: "must",
        },
      ],
      openQuestions: [],
    },
    executionPolicy: {
      workspaceIsolation: "dedicated_worktree",
      productionAccess: "denied",
      credentialHandling: "device_local_only",
      completionEvidence: "independent_runner_required",
    },
  },
});

export const workerConfig = (paths: {
  repositoryRoot: string;
  worktreeRoot: string;
}) =>
  DeviceWorkerConfigSchema.parse({
    schemaVersion: 1,
    controlPlaneUrl: "https://forgex.example.test",
    connection: {
      schemaVersion: 1,
      tenantKey,
      workerKey: "55555555-5555-4555-8555-555555555555",
      sessionKey: "s".repeat(43),
      generation: 1,
    },
    codexHomePath: `${paths.worktreeRoot}.codex-home`,
    codexIsolation: {
      launcherPath: `${paths.worktreeRoot}.isolation-launcher`,
      launcherSha256: "0".repeat(64),
      isolationKind: "separate_os_identity",
    },
    completionJournalPath: `${paths.worktreeRoot}.completion.json`,
    projects: [
      {
        projectKey,
        repositoryKey,
        repositoryRoot: paths.repositoryRoot,
        worktreeRoot: paths.worktreeRoot,
        baseRef: "main",
      },
    ],
  });
