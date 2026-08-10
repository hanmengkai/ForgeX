import { z } from "zod";

import type { VerificationRunnerRuntime } from "./runtime.js";

export type VerificationRunnerLoopResult = Awaited<
  ReturnType<VerificationRunnerRuntime["runOnce"]>
>;

const waitFor = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
};

export const runVerificationRunnerLoop = async (options: {
  runtime: Pick<VerificationRunnerRuntime, "runOnce">;
  idlePollIntervalMs: number;
  signal?: AbortSignal;
  onResult?: (result: VerificationRunnerLoopResult) => void;
  onError?: (error: { code: "verification_deferred" }) => void;
}): Promise<void> => {
  const idlePollIntervalMs = z
    .number()
    .int()
    .min(500)
    .max(60_000)
    .parse(options.idlePollIntervalMs);
  while (!options.signal?.aborted) {
    try {
      const result = await options.runtime.runOnce();
      options.onResult?.(result);
      if (options.signal?.aborted) break;
      if (result.kind === "submitted") continue;
    } catch {
      options.onError?.({ code: "verification_deferred" });
      if (options.signal?.aborted) break;
    }
    await waitFor(idlePollIntervalMs, options.signal);
  }
};
