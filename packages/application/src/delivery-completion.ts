import { createHash } from "node:crypto";

import {
  WorkerRequirementCompletionSchema,
  type WorkerRequirementCompletionPayload,
} from "@forgex/contracts";

export const requirementCompletionDigest = (
  input: WorkerRequirementCompletionPayload,
): string => {
  const completion = WorkerRequirementCompletionSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: completion.schemaVersion,
        assignmentKey: completion.assignmentKey,
        fencingToken: completion.fencingToken,
        projectKey: completion.projectKey,
        repositoryKey: completion.repositoryKey,
        requirementKey: completion.requirementKey,
        requirementRevision: completion.requirementRevision,
        gitHashAlgorithm: completion.gitHashAlgorithm,
        baseCommit: completion.baseCommit,
        commitSha: completion.commitSha,
        branchName: completion.branchName,
        summary: completion.summary,
      }),
      "utf8",
    )
    .digest("hex");
};
