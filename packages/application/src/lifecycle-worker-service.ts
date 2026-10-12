import { createHash } from "node:crypto";
import {
  LifecycleWorkerHeartbeatSchema,
  lifecycleStageLabels,
  type LifecycleExecutorPrincipal,
  type LifecycleWorkerView,
} from "@forgex/contracts/lifecycle";
import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type { LifecycleRepository } from "./lifecycle-service.js";
import { containsLikelyPlaintextCredential } from "./credential-safety.js";
export type LifecycleWorkerDescriptor = {
  principal: LifecycleExecutorPrincipal;
  displayName: string;
  provider: LifecycleWorkerView["provider"];
};
export class LifecycleWorkerService {
  constructor(
    readonly repository: LifecycleRepository,
    readonly directory: () => LifecycleWorkerDescriptor[],
    readonly clock: () => Date = () => new Date(),
  ) {}
  async heartbeat(
    executor: LifecycleExecutorPrincipal,
    input: unknown,
  ): Promise<void> {
    const parsed = LifecycleWorkerHeartbeatSchema.safeParse(input);
    if (
      !parsed.success ||
      containsLikelyPlaintextCredential(
        parsed.success ? parsed.data.displayName : "",
      )
    )
      throw new ApplicationError(
        422,
        "worker_heartbeat_invalid",
        "执行器状态格式不正确，请只填写账户显示名",
      );
    const expected = this.directory().find(
      (d) => d.principal.executorKey === executor.executorKey,
    );
    if (
      expected &&
      expected.provider !== "unknown" &&
      expected.provider !== parsed.data.provider
    )
      throw new ApplicationError(
        403,
        "worker_provider_mismatch",
        "执行方式与已登记执行器不一致",
      );
    await this.repository.transaction(executor.tenantKey, (state) => {
      state.workerHeartbeats = state.workerHeartbeats.filter(
        (h) => h.executorKey !== executor.executorKey,
      );
      state.workerHeartbeats.push({
        ...parsed.data,
        executorKey: executor.executorKey,
        lastSeenAt: this.clock().toISOString(),
      });
    });
  }
  async list(
    principal: AuthenticatedPrincipal,
  ): Promise<LifecycleWorkerView[]> {
    if (!principal.roles.some((r) => r !== "requester"))
      throw new ApplicationError(
        403,
        "worker_directory_forbidden",
        "当前身份无权查看团队执行器",
      );
    return this.repository.transaction(principal.tenantKey, (state) =>
      this.directory()
        .filter((d) => d.principal.tenantKey === principal.tenantKey)
        .map((d) => {
          const heartbeat = state.workerHeartbeats.find(
              (h) => h.executorKey === d.principal.executorKey,
            ),
            online =
              heartbeat &&
              this.clock().getTime() - Date.parse(heartbeat.lastSeenAt) < 45000;
          const work =
            state.workflows.flatMap((w) =>
              w.jobs
                .filter(
                  (j) =>
                    j.executorKey === d.principal.executorKey &&
                    j.status === "running" &&
                    j.leaseUntil &&
                    Date.parse(j.leaseUntil) > this.clock().getTime(),
                )
                .map((j) => `${w.title} · ${lifecycleStageLabels[j.stage]}`),
            )[0] ?? null;
          return {
            schemaVersion: 1,
            executorKey: d.principal.executorKey,
            displayName: heartbeat?.displayName ?? d.displayName,
            provider: heartbeat?.provider ?? d.provider,
            loginState: heartbeat?.loginState ?? "unknown",
            lastSeenAt: heartbeat?.lastSeenAt ?? null,
            status: !heartbeat
              ? "not_connected"
              : !online
                ? "offline"
                : heartbeat.executionState === "awaiting_confirmation"
                  ? "awaiting_confirmation"
                  : work || heartbeat.executionState === "executing"
                    ? "working"
                    : "idle",
            capabilities: d.principal.capabilities.map(
              (c) => lifecycleStageLabels[c],
            ),
            currentWork: online
              ? heartbeat.executionState === "awaiting_confirmation"
                ? "任务结果已保留，等待控制面确认"
                : work
              : null,
            identityFingerprint: createHash("sha256")
              .update(d.principal.publicKeyBase64)
              .digest("hex"),
          };
        }),
    );
  }
}
