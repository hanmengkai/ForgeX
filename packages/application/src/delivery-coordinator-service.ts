import { randomUUID } from "node:crypto";

import type { StartDeliveryCommandPayload } from "@forgex/contracts";

import type { AuthenticatedPrincipal } from "./auth.js";
import { ApplicationError } from "./errors.js";
import type {
  DeliveryDispatchRecord,
  RequirementRepository,
} from "./requirement-repository.js";
import type { RequirementApplicationService } from "./requirement-service.js";
import type { WorkerFleetService } from "./worker-fleet-service.js";

export interface DeliveryCoordinatorServiceOptions {
  requirements: RequirementApplicationService;
  requirementRepository: RequirementRepository;
  workers: WorkerFleetService;
  clock?: () => Date;
}

export class DeliveryCoordinatorService {
  readonly #requirements: RequirementApplicationService;
  readonly #requirementRepository: RequirementRepository;
  readonly #workers: WorkerFleetService;
  readonly #clock: () => Date;

  constructor(options: DeliveryCoordinatorServiceOptions) {
    this.#requirements = options.requirements;
    this.#requirementRepository = options.requirementRepository;
    this.#workers = options.workers;
    this.#clock = options.clock ?? (() => new Date());
  }

  async requestDelivery(
    principal: AuthenticatedPrincipal,
    requirementKey: string,
    command: StartDeliveryCommandPayload,
  ): Promise<{
    title: string;
    requirementRevision: number;
    status: "等待空闲设备" | "已经完成";
  }> {
    const dispatch = await this.#requirements.requestDelivery(
      principal,
      requirementKey,
      command,
    );
    let result: Awaited<ReturnType<WorkerFleetService["enqueueDispatch"]>>;
    try {
      result = await this.#workers.enqueueDispatch(dispatch);
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "queue_full") {
        throw error;
      }
      return {
        title: dispatch.title,
        requirementRevision: dispatch.requirementRevision,
        status: "等待空闲设备",
      };
    }
    await this.#markDispatched(dispatch);
    return {
      title: result.title,
      requirementRevision: dispatch.requirementRevision,
      status: result.status,
    };
  }

  async flushPending(tenantKey: string): Promise<number> {
    const pending =
      await this.#requirementRepository.listPendingDeliveryDispatches(
        tenantKey,
        null,
        100,
      );
    let dispatched = 0;
    for (const record of pending) {
      try {
        await this.#workers.enqueueDispatch(record);
      } catch (error) {
        if (error instanceof ApplicationError && error.code === "queue_full") {
          break;
        }
        throw error;
      }
      await this.#markDispatched(record);
      dispatched += 1;
    }
    return dispatched;
  }

  async #markDispatched(dispatch: DeliveryDispatchRecord): Promise<void> {
    await this.#requirementRepository.transaction(
      dispatch.tenantKey,
      dispatch.projectKey,
      (transaction) => {
        const recordedAt = this.#now().toISOString();
        if (
          !transaction.markDeliveryDispatched(dispatch.dispatchKey, recordedAt)
        ) {
          return;
        }
        transaction.appendAudit({
          eventKey: randomUUID(),
          tenantKey: dispatch.tenantKey,
          projectKey: dispatch.projectKey,
          requirementKey: dispatch.requirementKey,
          action: "delivery.dispatched",
          actorKey: "00000000-0000-4000-8000-000000000001",
          actorName: "ForgeX 调度器",
          recordedAt,
        });
      },
    );
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) {
      throw new Error("服务端时间无效");
    }
    return new Date(value.getTime());
  }
}
