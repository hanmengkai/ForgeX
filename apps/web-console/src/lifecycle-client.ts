import { z } from "zod";
import {
  LifecycleBugSchema,
  LifecycleContextSchema,
  LifecycleNotificationSchema,
  LifecycleViewSchema,
  type LifecycleBug,
  type LifecycleContext,
  type LifecycleNotification,
  type LifecycleRole,
  type LifecycleView,
  LifecycleWorkerViewSchema,
  type LifecycleWorkerView,
} from "@forgex/contracts/lifecycle";
import { createBrowserUuid } from "./browser-uuid.js";

export interface LifecycleClient {
  workers?(): Promise<LifecycleWorkerView[]>;
  context(): Promise<LifecycleContext>;
  list(): Promise<LifecycleView[]>;
  get(workflowKey: string): Promise<LifecycleView>;
  create(input: {
    title: string;
    brief: string;
    context: LifecycleContext;
  }): Promise<LifecycleView>;
  decide(
    flow: LifecycleView,
    input: {
      role: LifecycleRole;
      decision: "approve" | "reject" | "object";
      reason: string;
      rework?:
        | "requirements"
        | "design"
        | "implementation"
        | "verification"
        | "deployment";
    },
  ): Promise<LifecycleView>;
  action(
    flow: LifecycleView,
    input: {
      action: "retry" | "resolve_objection" | "request_recovery";
      reason: string;
      objectionKey?: string;
    },
  ): Promise<LifecycleView>;
  bugs(workflowKey: string): Promise<LifecycleBug[]>;
  reportBug(
    workflowKey: string,
    input: {
      title: string;
      description: string;
      severity: "critical" | "major" | "minor";
    },
  ): Promise<LifecycleBug>;
  repairBug(
    bugKey: string,
    action: "start_repair" | "resolve",
  ): Promise<LifecycleBug>;
  notifications(): Promise<LifecycleNotification[]>;
  readNotification(notificationKey: string): Promise<void>;
}
export const createLifecycleClient = (
  request: (path: string, init?: RequestInit) => Promise<Response>,
): LifecycleClient => {
  const json = async <T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> => {
    const init = body ? { method: "POST", body: JSON.stringify(body) } : {};
    let response: Response;
    try {
      response = await request(path, init);
    } catch (error) {
      if (!(error instanceof TypeError) || !body) throw error;
      response = await request(path, init);
    }
    return z
      .object({ data: schema })
      .strict()
      .parse(await response.json()).data;
  };
  const root = "/api/v2/lifecycle";
  return {
    workers: () =>
      json("/api/v2/workers", z.array(LifecycleWorkerViewSchema).max(10000)),
    context: () => json(`${root}/context`, LifecycleContextSchema),
    list: () => json(root, z.array(LifecycleViewSchema).max(200)),
    get: (key) => json(`${root}/${key}`, LifecycleViewSchema),
    create: (input) =>
      json(root, LifecycleViewSchema, {
        schemaVersion: 2,
        requestKey: createBrowserUuid(),
        title: input.title,
        brief: input.brief,
        projectKey: input.context.projectKey,
        repositoryKey: input.context.repositoryKey,
        requesterKey: input.context.actorKey,
      }),
    decide: (flow, input) =>
      json(`${root}/${flow.workflowKey}/decisions`, LifecycleViewSchema, {
        schemaVersion: 2,
        requestKey: createBrowserUuid(),
        expectedVersion: flow.version,
        ...input,
      }),
    action: (flow, input) =>
      json(`${root}/${flow.workflowKey}/actions`, LifecycleViewSchema, {
        schemaVersion: 2,
        requestKey: createBrowserUuid(),
        expectedVersion: flow.version,
        ...input,
      }),
    bugs: (key) =>
      json(`${root}/${key}/bugs`, z.array(LifecycleBugSchema).max(1_000)),
    reportBug: (key, input) =>
      json(`${root}/${key}/bugs`, LifecycleBugSchema, {
        schemaVersion: 2,
        requestKey: createBrowserUuid(),
        ...input,
      }),
    repairBug: (key, action) =>
      json(`/api/v2/bugs/${key}/actions`, LifecycleBugSchema, {
        schemaVersion: 2,
        requestKey: createBrowserUuid(),
        action,
      }),
    notifications: () =>
      json(
        "/api/v2/notifications",
        z.array(LifecycleNotificationSchema).max(200),
      ),
    readNotification: async (key) => {
      await request(`/api/v2/notifications/${key}/read`, {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 2 }),
      });
    },
  };
};
