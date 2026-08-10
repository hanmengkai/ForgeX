import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Ed25519RunnerEvidenceSigner,
  FileVerificationJournal,
  VerificationSignedJournalEntrySchema,
  verificationArtifactEntry,
  verificationSignedEntry,
  type VerificationRunnerTarget,
} from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const target: VerificationRunnerTarget = {
  requirementKey: "60000000-0000-4000-8000-000000000006",
  requirementRevision: 2,
  repositoryKey: "30000000-0000-4000-8000-000000000003",
  gitHashAlgorithm: "sha1",
  commitSha: "a".repeat(40),
  title: "访客预约",
  goal: "让访客可以提前预约",
  acceptanceCriteria: [
    {
      criterionKey: "70000000-0000-4000-8000-000000000007",
      title: "预约成功",
      description: "提交后可以看到预约结果",
      priority: "must",
    },
  ],
  previewArtifact: null,
};

const artifact = new TextEncoder().encode("<html>可信预览</html>");
const artifactHash =
  "6d161a76d3146278ed0339a5bb3ef099883fed91c30d88a98396383c94410a4e";
const integrityKey = new Uint8Array(32).fill(0x5a);
const testJournalOptions = {
  assertWindowsPrivatePath: async () => Promise.resolve(),
};
const artifactEntry = verificationArtifactEntry({
  target,
  evidenceKey: "80000000-0000-4000-8000-000000000008",
  artifact,
  artifactHash,
  verificationCompletedAt: "2026-08-11T03:00:00.000Z",
  integrityKey,
  checks: [
    {
      criterionKey: target.acceptanceCriteria[0]!.criterionKey,
      status: "passed",
      testRunKey: "suite-a1",
    },
  ],
});

describe("FileVerificationJournal", () => {
  it("原子保存 Preview 与已签名证据，重启后恢复完全相同内容", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const filePath = path.join(root, "verification-journal.json");
    let journal = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );
    await journal.saveArtifact(artifactEntry);
    await journal.close();
    journal = await FileVerificationJournal.open(filePath, testJournalOptions);
    await expect(journal.load()).resolves.toEqual(artifactEntry);

    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new Ed25519RunnerEvidenceSigner({
      runnerKey: "40000000-0000-4000-8000-000000000004",
      keyId: "50000000-0000-4000-8000-000000000005",
      privateKey,
    });
    const signedEvidence = await signer.sign({
      schemaVersion: 1,
      evidenceKey: artifactEntry.evidenceKey,
      tenantKey: "10000000-0000-4000-8000-000000000001",
      projectKey: "20000000-0000-4000-8000-000000000002",
      repositoryKey: target.repositoryKey,
      requirementKey: target.requirementKey,
      requirementRevision: target.requirementRevision,
      gitHashAlgorithm: target.gitHashAlgorithm,
      commitSha: target.commitSha,
      runnerKey: "40000000-0000-4000-8000-000000000004",
      keyId: "50000000-0000-4000-8000-000000000005",
      producedAt: "2026-08-11T03:01:00.000Z",
      artifactHashAlgorithm: "sha256",
      artifactHash,
      checks: artifactEntry.checks,
    });
    const signedEntry = verificationSignedEntry({
      artifactEntry,
      signedEvidence,
      integrityKey,
    });
    await journal.saveSigned(signedEntry);
    await expect(journal.load()).resolves.toEqual(signedEntry);

    await expect(journal.clear(artifactEntry.integrityTag)).rejects.toThrow(
      "已经变化",
    );
    await journal.clear(signedEntry.integrityTag);
    await expect(journal.load()).resolves.toBeNull();
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await journal.close();
  });

  it("拒绝用另一任务覆盖未完成日志", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const journal = await FileVerificationJournal.open(
      path.join(root, "verification-journal.json"),
      testJournalOptions,
    );
    await journal.saveArtifact(artifactEntry);

    await expect(
      journal.saveArtifact({
        ...artifactEntry,
        evidenceKey: "90000000-0000-4000-8000-000000000009",
      }),
    ).rejects.toThrow("不能覆盖");
    await journal.close();
  });

  it("同一路径只能由一个 Runner 进程持有", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const filePath = path.join(root, "verification-journal.json");
    const first = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );

    await expect(
      FileVerificationJournal.open(filePath, testJournalOptions),
    ).rejects.toThrow("已经运行");
    await first.close();
    const second = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );
    await second.close();
  });
});
