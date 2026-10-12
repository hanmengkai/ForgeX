import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
const run = promisify(execFile);
describe.skipIf(process.platform !== "darwin")(
  "独立执行器的持久化交付与故障恢复",
  () => {
    it("独立目录经 HTTP 交接制品，控制面重启、断网、执行器强制退出和回执确认丢失不重复发布", async () => {
      await run(process.execPath, ["node_modules/typescript/bin/tsc", "-b"], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      });
      const root = await mkdtemp(path.join(os.tmpdir(), "forgex-durable-e2e-"));
      try {
        const module = await import(
          new URL("../../../scripts/verify-p0-durable.mjs", import.meta.url)
            .href
        );
        const report = await module.verifyDurableSample({
          root,
          mode: "fixture",
        });
        expect(report.stage).toBe("closed");
        expect(report.uniquePublishCount).toBe(1);
        expect(report.confirmationAttempts).toBe(2);
        expect(report.sameSignedCompletion).toBe(true);
        expect(report.controllerRestarted).toBe(true);
        expect(report.workerRestarted).toBe(true);
        expect(report.offlineReceiptPreserved).toBe(true);
        expect(report.artifactUploadRecovered).toBe(true);
        expect(report.independentDesignReview).toBe(true);
        expect(report.bugEntry).toBe(true);
        expect(report.artifactDownloads).toBeGreaterThanOrEqual(3);
        expect(report.modelMode).toBe("fixture");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 90000);
  },
);
