import { describe, expect, it, vi } from "vitest";

import { runVerificationRunnerLoop } from "../src/index.js";

describe("runVerificationRunnerLoop", () => {
  it("空闲时按间隔等待，并在终止信号到来后退出", async () => {
    const abort = new AbortController();
    const onResult = vi.fn(() => abort.abort("test_complete"));
    const runtime = {
      runOnce: vi.fn(async () => ({ kind: "idle" as const })),
    };

    await expect(
      runVerificationRunnerLoop({
        runtime,
        idlePollIntervalMs: 500,
        signal: abort.signal,
        onResult,
      }),
    ).resolves.toBeUndefined();
    expect(runtime.runOnce).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith({ kind: "idle" });
  });

  it("单次验证异常不会退出常驻进程，也不会把异常文本交给普通日志", async () => {
    const abort = new AbortController();
    const onError = vi.fn(() => abort.abort("test_complete"));
    const runtime = {
      runOnce: vi.fn(async () => {
        throw new Error("Authorization: Bearer local-secret-marker");
      }),
    };

    await runVerificationRunnerLoop({
      runtime,
      idlePollIntervalMs: 500,
      signal: abort.signal,
      onError,
    });
    expect(onError).toHaveBeenCalledWith({ code: "verification_deferred" });
    expect(JSON.stringify(onError.mock.calls)).not.toContain(
      "local-secret-marker",
    );
  });
});
