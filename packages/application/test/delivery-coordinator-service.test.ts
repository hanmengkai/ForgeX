import { describe, expect, it } from "vitest";

import type { RequirementSpec } from "@forgex/contracts";

import {
  DeliveryCoordinatorService,
  InMemoryRequirementRepository,
  InMemoryWorkerFleetRepository,
  RequirementApplicationService,
  WorkerFleetService,
  type AuthenticatedPrincipal,
  type RequirementRepository,
  type RequirementTransaction,
} from "../src/index.js";

const tenantKey = "11111111-1111-4111-8111-111111111111";
const projectKey = "22222222-2222-4222-8222-222222222222";
const principal: AuthenticatedPrincipal = {
  actorKey: "33333333-3333-4333-8333-333333333333",
  actorName: "产品负责人",
  tenantKey,
  roles: ["product_owner", "administrator"],
};
const spec: RequirementSpec = {
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
};

class FailFirstDispatchMarkRepository implements RequirementRepository {
  readonly #inner = new InMemoryRequirementRepository();
  #shouldFailMark = true;

  transaction<T>(
    scopedTenantKey: string,
    scopedProjectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T> {
    return this.#inner.transaction(
      scopedTenantKey,
      scopedProjectKey,
      (transaction) =>
        operation({
          ...transaction,
          markDeliveryDispatched: (dispatchKey, dispatchedAt) => {
            if (this.#shouldFailMark) {
              this.#shouldFailMark = false;
              throw new Error("模拟派发标记落库失败");
            }
            return transaction.markDeliveryDispatched(
              dispatchKey,
              dispatchedAt,
            );
          },
        }),
    );
  }

  listForPeople = this.#inner.listForPeople.bind(this.#inner);
  listAuditEvents = this.#inner.listAuditEvents.bind(this.#inner);
  listPendingDeliveryDispatches =
    this.#inner.listPendingDeliveryDispatches.bind(this.#inner);
}

describe("DeliveryCoordinatorService", () => {
  it("派发后标记失败时由 outbox 重试，且同一版本只进入队列一次", async () => {
    const requirementRepository = new FailFirstDispatchMarkRepository();
    const requirements = new RequirementApplicationService({
      repository: requirementRepository,
      projectKey,
    });
    const workers = new WorkerFleetService({
      repository: new InMemoryWorkerFleetRepository(),
    });
    const coordinator = new DeliveryCoordinatorService({
      requirements,
      requirementRepository,
      workers,
    });
    const connection = (
      await workers.connect(principal, {
        schemaVersion: 1,
        deviceName: "研发电脑",
        accountName: "Codex 账户",
        accountFingerprint: "a".repeat(64),
        capabilities: ["typescript"],
      })
    ).connection;
    const created = await requirements.create(principal, spec);
    await requirements.submitForConfirmation(principal, created.requirementKey);
    await requirements.confirm(principal, created.requirementKey);

    await expect(
      coordinator.requestDelivery(principal, created.requirementKey, {
        schemaVersion: 1,
        requiredCapabilities: ["typescript"],
      }),
    ).rejects.toThrow("模拟派发标记落库失败");
    await expect(coordinator.flushPending(tenantKey)).resolves.toBe(1);
    await expect(coordinator.flushPending(tenantKey)).resolves.toBe(0);

    const first = (await workers.poll(connection)).assignment;
    const repeated = (await workers.poll(connection)).assignment;
    expect(first).toMatchObject({
      projectKey,
      requirementKey: created.requirementKey,
      requirementRevision: 1,
      title: spec.title,
    });
    expect(repeated).toEqual(first);
    const audit = await requirementRepository.listAuditEvents(
      tenantKey,
      projectKey,
    );
    expect(
      audit.filter((event) => event.action === "delivery.dispatched"),
    ).toHaveLength(1);
  });
});
