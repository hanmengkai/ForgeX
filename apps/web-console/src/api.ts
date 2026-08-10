import { z } from "zod";

export interface RequirementActionLinks {
  submitConfirmation?: string | undefined;
  confirm?: string | undefined;
  startDelivery?: string | undefined;
  accept?: string | undefined;
}

export interface RequirementListItem {
  title: string;
  summary: string;
  version: string;
  status:
    | "正在整理"
    | "等待负责人确认"
    | "已确认，等待交付"
    | "内容已更新，等待重新确认"
    | "AI 正在实现"
    | "等待产品验收"
    | "已完成";
  nextStep: string;
  acceptanceProgress: string;
  links: {
    self: string;
    preview?: string | undefined;
    actions: RequirementActionLinks;
  };
}

export interface RequirementDetail extends RequirementListItem {
  spec: RequirementSpecInput;
  acceptance: {
    verifiedBy: string;
    verifiedAt: string;
    checks: Array<{ title: string; status: "已通过" }>;
  } | null;
}

export interface RequirementSpecInput {
  schemaVersion: 1;
  title: string;
  goal: string;
  userStories: Array<{ role: string; need: string; value: string }>;
  acceptanceCriteria: Array<{
    title: string;
    description: string;
    priority: "must" | "should" | "could";
  }>;
  openQuestions: string[];
}

export interface RequirementListPage {
  items: RequirementListItem[];
  nextCursor: string | null;
}

export interface WorkerListItem {
  deviceName: string;
  accountName: string;
  status: "空闲" | "正在工作" | "离线";
  currentWork: string | null;
}

export interface WorkerFleetOverview {
  workers: WorkerListItem[];
  capacity: {
    connectedAccounts: number;
    maxAccounts: number;
    availableSlots: number;
  };
}

export interface ExtensionCatalogItem {
  name: string;
  summary: string;
  status: "可使用" | "正在更新" | "需要处理" | "暂不可用";
  detail: string;
  supportingText: string;
  links: { self: string };
}

export interface ExtensionCatalogOverview {
  businessKnowledge: ExtensionCatalogItem[];
  teamCapabilities: ExtensionCatalogItem[];
  externalTools: ExtensionCatalogItem[];
}

export interface ForgeXClient {
  listRequirements(): Promise<RequirementListPage>;
  listWorkers(): Promise<WorkerFleetOverview>;
  listExtensions(): Promise<ExtensionCatalogOverview>;
  getRequirement(selfUrl: string): Promise<RequirementDetail>;
  createRequirement(spec: RequirementSpecInput): Promise<void>;
  runRequirementAction(
    actionUrl: string | undefined,
    body: Record<string, unknown>,
  ): Promise<void>;
}

const requirementStatuses = [
  "正在整理",
  "等待负责人确认",
  "已确认，等待交付",
  "内容已更新，等待重新确认",
  "AI 正在实现",
  "等待产品验收",
  "已完成",
] as const;
const requirementSelfPattern =
  /^\/api\/v1\/requirements\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionSuffixes = {
  submitConfirmation: "/submit-confirmation",
  confirm: "/confirm",
  startDelivery: "/start-delivery",
  accept: "/accept",
} as const;

const requirementLinksSchema = z
  .object({
    self: z.string().regex(requirementSelfPattern),
    preview: z.string().optional(),
    actions: z
      .object({
        submitConfirmation: z.string().optional(),
        confirm: z.string().optional(),
        startDelivery: z.string().optional(),
        accept: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((links, context) => {
    if (
      links.preview !== undefined &&
      links.preview !== `${links.self}/preview`
    ) {
      context.addIssue({
        code: "custom",
        path: ["preview"],
        message: "Preview 链接与需求不匹配",
      });
    }
    for (const [action, suffix] of Object.entries(actionSuffixes) as Array<
      [keyof RequirementActionLinks, string]
    >) {
      const actionUrl = links.actions[action];
      if (actionUrl !== undefined && actionUrl !== `${links.self}${suffix}`) {
        context.addIssue({
          code: "custom",
          path: ["actions", action],
          message: "动作链接与需求不匹配",
        });
      }
    }
  });

const requirementListItemSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    summary: z.string().trim().min(1).max(2_000),
    version: z.string().trim().min(1).max(40),
    status: z.enum(requirementStatuses),
    nextStep: z.string().trim().min(1).max(500),
    acceptanceProgress: z.string().trim().min(1).max(500),
    links: requirementLinksSchema,
  })
  .strict();

const requirementSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string(),
    goal: z.string(),
    userStories: z.array(
      z
        .object({ role: z.string(), need: z.string(), value: z.string() })
        .strict(),
    ),
    acceptanceCriteria: z.array(
      z
        .object({
          title: z.string(),
          description: z.string(),
          priority: z.enum(["must", "should", "could"]),
        })
        .strict(),
    ),
    openQuestions: z.array(z.string()),
  })
  .strict();

const requirementListResponseSchema = z
  .object({
    data: z.array(requirementListItemSchema).max(100),
    meta: z
      .object({ nextCursor: z.string().min(1).max(500).nullable() })
      .strict(),
  })
  .strict();
const requirementDetailResponseSchema = z
  .object({
    data: requirementListItemSchema
      .extend({
        spec: requirementSpecSchema,
        acceptance: z
          .object({
            verifiedBy: z.string().trim().min(2).max(100),
            verifiedAt: z.iso.datetime(),
            checks: z
              .array(
                z
                  .object({
                    title: z.string().trim().min(2).max(150),
                    status: z.literal("已通过"),
                  })
                  .strict(),
              )
              .min(1)
              .max(80),
          })
          .strict()
          .nullable(),
      })
      .superRefine((detail, context) => {
        const shouldHaveAcceptance =
          detail.status === "等待产品验收" || detail.status === "已完成";
        if (shouldHaveAcceptance !== (detail.acceptance !== null)) {
          context.addIssue({
            code: "custom",
            path: ["acceptance"],
            message: "验收信息与需求状态不一致",
          });
        }
        if (shouldHaveAcceptance !== (detail.links.preview !== undefined)) {
          context.addIssue({
            code: "custom",
            path: ["links", "preview"],
            message: "Preview 链接与验收状态不一致",
          });
        }
        if (
          detail.acceptance &&
          (detail.acceptance.checks.length !==
            detail.spec.acceptanceCriteria.length ||
            detail.acceptance.checks.some(
              (check, index) =>
                check.title !== detail.spec.acceptanceCriteria[index]?.title,
            ))
        ) {
          context.addIssue({
            code: "custom",
            path: ["acceptance", "checks"],
            message: "验收结果没有覆盖全部完成标准",
          });
        }
      }),
  })
  .strict();

const workerListResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            deviceName: z.string().trim().min(2).max(100),
            accountName: z.string().trim().min(2).max(100),
            status: z.enum(["空闲", "正在工作", "离线"]),
            currentWork: z.string().trim().min(2).max(150).nullable(),
          })
          .strict()
          .superRefine((worker, context) => {
            if (
              (worker.status === "正在工作" && worker.currentWork === null) ||
              (worker.status !== "正在工作" && worker.currentWork !== null)
            ) {
              context.addIssue({
                code: "custom",
                path: ["currentWork"],
                message: "设备工作内容与状态不一致",
              });
            }
          }),
      )
      .max(5),
    meta: z
      .object({
        connectedAccounts: z.number().int().min(0).max(5),
        maxAccounts: z.number().int().min(1).max(5),
        availableSlots: z.number().int().min(0).max(5),
      })
      .strict(),
  })
  .strict()
  .superRefine((overview, context) => {
    if (
      overview.data.length !== overview.meta.connectedAccounts ||
      overview.meta.connectedAccounts + overview.meta.availableSlots !==
        overview.meta.maxAccounts
    ) {
      context.addIssue({
        code: "custom",
        path: ["meta"],
        message: "设备容量与列表不一致",
      });
    }
  });

const extensionSelfPattern =
  /^\/api\/v1\/extensions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const extensionCatalogItemSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    status: z.enum(["可使用", "正在更新", "需要处理", "暂不可用"]),
    detail: z.string().trim().min(2).max(200),
    supportingText: z.string().trim().min(2).max(200),
    links: z.object({ self: z.string().regex(extensionSelfPattern) }).strict(),
  })
  .strict();
const extensionCatalogResponseSchema = z
  .object({
    data: z
      .object({
        businessKnowledge: z.array(extensionCatalogItemSchema).max(100),
        teamCapabilities: z.array(extensionCatalogItemSchema).max(100),
        externalTools: z.array(extensionCatalogItemSchema).max(100),
      })
      .strict(),
  })
  .strict();

const assertRequirementSelfUrl = (url: string): void => {
  if (!requirementSelfPattern.test(url)) {
    throw new Error("这个需求入口已经失效，请刷新页面后重试");
  }
};

const assertRequirementActionUrl = (url: string | undefined): string => {
  if (!url) {
    throw new Error("这个操作已经失效，请刷新页面后重试");
  }
  const suffix = Object.values(actionSuffixes).find((item) =>
    url.endsWith(item),
  );
  const selfUrl = suffix ? url.slice(0, -suffix.length) : "";
  if (!suffix || !requirementSelfPattern.test(selfUrl)) {
    throw new Error("这个操作已经失效，请刷新页面后重试");
  }
  return url;
};

interface HttpClientOptions {
  baseUrl?: string;
  authorization?: string;
  fetcher?: typeof fetch;
}

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown };
    };
    if (typeof body.error?.message === "string" && body.error.message.trim()) {
      return body.error.message;
    }
  } catch {
    // 非 JSON 响应使用统一的用户提示。
  }
  return "服务暂时没有响应，请稍后再试";
};

export const createHttpForgeXClient = (
  options: HttpClientOptions = {},
): ForgeXClient => {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) {
      headers.set("Content-Type", "application/json");
    }
    if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method)) {
      headers.set("X-ForgeX-CSRF", "1");
    }
    if (options.authorization) {
      headers.set("Authorization", options.authorization);
    }
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    return response;
  };

  return {
    listRequirements: async () => {
      const response = await request("/api/v1/requirements?limit=100");
      const parsed = requirementListResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("需求列表格式不正确，请联系管理员");
      }
      return {
        items: parsed.data.data,
        nextCursor: parsed.data.meta.nextCursor,
      };
    },
    listWorkers: async () => {
      const response = await request("/api/v1/workers");
      const parsed = workerListResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("设备列表格式不正确，请联系管理员");
      }
      return {
        workers: parsed.data.data,
        capacity: parsed.data.meta,
      };
    },
    listExtensions: async () => {
      const response = await request("/api/v1/extensions");
      const parsed = extensionCatalogResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("扩展目录格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    getRequirement: async (selfUrl) => {
      assertRequirementSelfUrl(selfUrl);
      const response = await request(selfUrl);
      const parsed = requirementDetailResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("需求详情格式不正确，请联系管理员");
      }
      if (parsed.data.data.links.self !== selfUrl) {
        throw new Error("需求详情与当前需求不匹配，请刷新页面后重试");
      }
      return parsed.data.data;
    },
    createRequirement: async (spec) => {
      await request("/api/v1/requirements", {
        method: "POST",
        body: JSON.stringify(spec),
      });
    },
    runRequirementAction: async (actionUrl, body) => {
      await request(assertRequirementActionUrl(actionUrl), {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  };
};
