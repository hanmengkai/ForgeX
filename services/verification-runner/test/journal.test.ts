import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
const runnerScope = {
  tenantKey: "10000000-0000-4000-8000-000000000001",
  projectKey: "20000000-0000-4000-8000-000000000002",
  repositoryKey: target.repositoryKey,
  runnerKey: "40000000-0000-4000-8000-000000000004",
  keyId: "50000000-0000-4000-8000-000000000005",
};
const testJournalOptions = {
  assertWindowsPrivatePath: async () => Promise.resolve(),
};
const lockDatabasePath = (root: string): string =>
  path.join(root, ".forgex-verification-runner-locks.sqlite");
const artifactEntry = verificationArtifactEntry({
  scope: runnerScope,
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
    await journal.saveSigned(signedEntry, artifactEntry.integrityTag);
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

    const lockArtifacts = await readdir(root);
    expect(
      lockArtifacts.filter(
        (name) => name.endsWith(".sock") || name.endsWith(".lock"),
      ),
    ).toEqual([]);
    expect(lockArtifacts).toContain(path.basename(lockDatabasePath(root)));
    const lockDatabase = new DatabaseSync(lockDatabasePath(root), {
      readOnly: true,
    });
    const lockDescriptor = lockDatabase
      .prepare(
        `
          SELECT
            schema_version AS schemaVersion,
            state,
            identity_hash AS identityHash,
            owner_token AS ownerToken,
            process_id AS processId,
            process_start_key AS processStartKey
          FROM runner_instance_locks
        `,
      )
      .get();
    lockDatabase.close();
    expect(lockDescriptor).toMatchObject({
      schemaVersion: 1,
      state: "active",
      identityHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ownerToken: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      processId: process.pid,
      processStartKey: expect.stringMatching(/^[A-Za-z0-9:._-]+$/u),
    });

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

  it("多个 Runner 并发竞争同一路径时只能有一个实例取得锁", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    for (let index = 0; index < 10; index += 1) {
      const filePath = path.join(root, `verification-journal-${index}.json`);
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, async () =>
          FileVerificationJournal.open(filePath, testJournalOptions),
        ),
      );
      const acquired = results.filter(
        (result): result is PromiseFulfilledResult<FileVerificationJournal> =>
          result.status === "fulfilled",
      );
      expect(acquired).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(4);
      await acquired[0]!.value.close();
    }
  });

  it("只在 OS 能证明原进程已退出时回收崩溃遗留锁", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const filePath = path.join(root, "verification-journal.json");
    const identity =
      process.platform === "win32"
        ? path.resolve(filePath).toLowerCase()
        : path.resolve(filePath);
    const identityHash = createHash("sha256")
      .update(identity, "utf8")
      .digest("hex");
    const initialized = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );
    await initialized.close();
    const lockDatabase = new DatabaseSync(lockDatabasePath(root));
    lockDatabase
      .prepare(
        `
          INSERT INTO runner_instance_locks (
            schema_version,
            state,
            identity_hash,
            owner_token,
            process_id,
            process_start_key
          ) VALUES (1, 'active', ?, ?, ?, ?)
        `,
      )
      .run(identityHash, randomUUID(), 2_147_483_647, "dead-process-start");
    lockDatabase.close();

    const recovered = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );
    const recoveredDatabase = new DatabaseSync(lockDatabasePath(root), {
      readOnly: true,
    });
    expect(
      recoveredDatabase
        .prepare(
          "SELECT process_id AS processId FROM runner_instance_locks WHERE identity_hash = ?",
        )
        .get(identityHash),
    ).toMatchObject({ processId: process.pid });
    recoveredDatabase.close();
    await recovered.close();
  });

  it("升级后不会被旧版中断回收留下的锁文件阻塞", async () => {
    const root = path.join(os.tmpdir(), `forgex-runner-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const filePath = path.join(root, "verification-journal.json");
    const identity =
      process.platform === "win32"
        ? path.resolve(filePath).toLowerCase()
        : path.resolve(filePath);
    const identityHash = createHash("sha256")
      .update(identity, "utf8")
      .digest("hex");
    const lockPath = path.join(
      root,
      `.forgex-verification-runner-${identityHash.slice(0, 24)}.lck`,
    );
    const ownerToken = randomUUID();
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        state: "active",
        identityHash,
        ownerToken,
        processId: 2_147_483_647,
        processStartKey: "dead-process-start",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await link(lockPath, `${lockPath}.stale-${ownerToken}`);

    const recovered = await FileVerificationJournal.open(
      filePath,
      testJournalOptions,
    );
    await recovered.close();
  });
});
