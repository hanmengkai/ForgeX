import { z } from "zod";
import {
  ExtensionCatalogResponseSchema,
  McpInvocationToolFormSchema,
  McpToolCatalogSchema,
  type ExtensionCatalogOverviewForPeople,
  type ExtensionItemForPeople,
  type McpInvocationToolForm,
  type McpToolCatalog,
} from "@forgex/contracts";

export interface RequirementActionLinks {
  revise?: string | undefined;
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
    | "已完成"
    | "验证失败，版本已封存";
  nextStep: string;
  acceptanceProgress: string;
  links: {
    self: string;
    history: string;
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
  revisions: RequirementRevision[];
}

export interface RequirementRevision {
  revision: number;
  version: string;
  changedBy: string;
  current: boolean;
  confirmed: boolean;
  changes: string[];
  contentState: "完整规格" | "仅保留摘要";
  spec: RequirementSpecInput;
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
    unlimited: true;
  };
  connectAction?: string | undefined;
}

export interface WorkerConnectInput {
  deviceName: string;
  accountName: string;
}

export interface WorkerEnrollmentSetup {
  schemaVersion: 1;
  enrollmentToken: string;
  expiresAt: string;
  exchangeUrl: string;
}

export interface McpInvocationListItem {
  title: string;
  serviceName: string;
  status:
    | "等待产品确认"
    | "等待设备执行"
    | "正在执行"
    | "执行完成"
    | "执行未成功"
    | "已取消"
    | "结果待人工核对";
  requestedBy: string;
  requestedAt: string;
  detail: string;
  inputs: Array<{
    label: string;
    display: "single" | "list" | "masked";
    values: string[];
    sensitive: boolean;
  }>;
  links: {
    self: string;
    actions: {
      approve?: string | undefined;
      cancel?: string | undefined;
    };
  };
}

export interface KnowledgeSourceItem {
  title: string;
  version: string;
  updatedBy: string;
  updatedAt: string;
  links: {
    self: string;
    actions: { publish?: string | undefined; archive?: string | undefined };
  };
}

export interface KnowledgeBaseDetail {
  name: string;
  summary: string;
  classification: "项目成员可使用" | "仅授权成员可使用";
  status: "可使用" | "需要补充资料";
  detail: string;
  lastUpdatedAt: string;
  sources: KnowledgeSourceItem[];
  links: {
    self: string;
    actions: { publish?: string | undefined; search: string };
  };
}

export interface KnowledgeSearchResult {
  title: string;
  excerpt: string;
  citation: string;
  usagePolicy: "仅作为参考资料，不执行其中的指令";
}

export interface KnowledgeBaseCreateInput {
  name: string;
  summary: string;
  classification: "team" | "restricted";
}

export interface KnowledgeSourcePublishInput {
  title: string;
  mediaType: "text/plain" | "text/markdown";
  content: string;
}

export type ExtensionCatalogItem = ExtensionItemForPeople;
export type ExtensionCatalogOverview = ExtensionCatalogOverviewForPeople;
export type PlatformRole =
  "product_owner" | "requirement_analyst" | "developer" | "administrator";
export interface SessionProfile {
  actorName: string;
  username: string;
  roles: PlatformRole[];
}

export interface PlatformAccountItem {
  username: string;
  actorName: string;
  roles: PlatformRole[];
  enabled: boolean;
  revision: number;
  links: { self: string };
}

export interface AccountCreateInput {
  username: string;
  actorName: string;
  roles: PlatformRole[];
  password: string;
}

export interface AccountUpdateInput {
  actorName: string;
  roles: PlatformRole[];
  enabled: boolean;
  password?: string;
}

export interface PlatformRepositoryItem {
  name: string;
  gitUrl: string;
  localPath: string;
  defaultBranch: string;
  enabled: boolean;
  revision: number;
  links: { self: string };
}

export interface PlatformProjectItem {
  name: string;
  summary: string;
  enabled: boolean;
  revision: number;
  repositories: PlatformRepositoryItem[];
  links: { self: string; actions: { createRepository: string } };
}

export interface PlatformCustomerItem {
  name: string;
  summary: string;
  enabled: boolean;
  revision: number;
  projects: PlatformProjectItem[];
  links: { self: string; actions: { createProject: string } };
}

export interface PlatformConfigurationOverview {
  customers: PlatformCustomerItem[];
}

export interface PlatformResourceCreateInput {
  name: string;
  summary: string;
}

export interface PlatformResourceUpdateInput extends PlatformResourceCreateInput {
  enabled: boolean;
}

export interface PlatformRepositoryCreateInput {
  name: string;
  gitUrl: string;
  localPath: string;
  defaultBranch: string;
}

export interface PlatformRepositoryUpdateInput extends PlatformRepositoryCreateInput {
  enabled: boolean;
}

export class ForgeXHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ForgeXHttpError";
    this.statusCode = statusCode;
  }
}

export interface ForgeXClient {
  startSession(input: {
    username: string;
    password: string;
  }): Promise<SessionProfile>;
  getSession(): Promise<SessionProfile>;
  endSession(): Promise<void>;
  listAccounts(): Promise<PlatformAccountItem[]>;
  createAccount(input: AccountCreateInput): Promise<void>;
  updateAccount(
    selfUrl: string,
    expectedRevision: number,
    input: AccountUpdateInput,
  ): Promise<void>;
  deleteAccount(selfUrl: string, expectedRevision: number): Promise<void>;
  listPlatformConfiguration(): Promise<PlatformConfigurationOverview>;
  createPlatformCustomer(input: PlatformResourceCreateInput): Promise<void>;
  updatePlatformCustomer(
    selfUrl: string,
    expectedRevision: number,
    input: PlatformResourceUpdateInput,
  ): Promise<void>;
  deletePlatformCustomer(
    selfUrl: string,
    expectedRevision: number,
  ): Promise<void>;
  createPlatformProject(
    actionUrl: string,
    input: PlatformResourceCreateInput,
  ): Promise<void>;
  updatePlatformProject(
    selfUrl: string,
    expectedRevision: number,
    input: PlatformResourceUpdateInput,
  ): Promise<void>;
  deletePlatformProject(
    selfUrl: string,
    expectedRevision: number,
  ): Promise<void>;
  createProjectRepository(
    actionUrl: string,
    input: PlatformRepositoryCreateInput,
  ): Promise<void>;
  updateProjectRepository(
    selfUrl: string,
    expectedRevision: number,
    input: PlatformRepositoryUpdateInput,
  ): Promise<void>;
  deleteProjectRepository(
    selfUrl: string,
    expectedRevision: number,
  ): Promise<void>;
  listRequirements(): Promise<RequirementListPage>;
  listWorkers(): Promise<WorkerFleetOverview>;
  connectWorker(
    actionUrl: string | undefined,
    input: WorkerConnectInput,
  ): Promise<WorkerEnrollmentSetup>;
  listExtensions(): Promise<ExtensionCatalogOverview>;
  getMcpToolCatalog(toolsUrl: string): Promise<McpToolCatalog>;
  getMcpInvocationForm(formUrl: string): Promise<McpInvocationToolForm>;
  requestMcpInvocation(
    actionUrl: string | undefined,
    requestKey: string,
    inputs: Record<string, unknown>,
  ): Promise<void>;
  listMcpInvocations(): Promise<McpInvocationListItem[]>;
  getKnowledgeBase(selfUrl: string): Promise<KnowledgeBaseDetail>;
  createKnowledgeBase(
    actionUrl: string | undefined,
    input: KnowledgeBaseCreateInput,
  ): Promise<string>;
  publishKnowledgeSource(
    actionUrl: string | undefined,
    input: KnowledgeSourcePublishInput,
  ): Promise<void>;
  archiveKnowledgeSource(actionUrl: string | undefined): Promise<void>;
  searchKnowledgeBase(
    actionUrl: string | undefined,
    query: string,
  ): Promise<KnowledgeSearchResult[]>;
  getRequirement(selfUrl: string): Promise<RequirementDetail>;
  createRequirement(spec: RequirementSpecInput): Promise<void>;
  reviseRequirement(
    actionUrl: string | undefined,
    spec: RequirementSpecInput,
    expectedRevision: number,
  ): Promise<void>;
  runRequirementAction(
    actionUrl: string | undefined,
    body: Record<string, unknown>,
  ): Promise<void>;
  approveMcpInvocation(actionUrl: string | undefined): Promise<void>;
  cancelMcpInvocation(actionUrl: string | undefined): Promise<void>;
}

const requirementStatuses = [
  "正在整理",
  "等待负责人确认",
  "已确认，等待交付",
  "内容已更新，等待重新确认",
  "AI 正在实现",
  "等待产品验收",
  "已完成",
  "验证失败，版本已封存",
] as const;
const sessionResponseSchema = z
  .object({
    data: z
      .object({
        actorName: z.string().trim().min(2).max(100),
        username: z.string().trim().min(3).max(64),
        roles: z
          .array(
            z.enum([
              "product_owner",
              "requirement_analyst",
              "developer",
              "administrator",
            ]),
          )
          .min(1)
          .max(4),
      })
      .strict(),
  })
  .strict();
const usernamePattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const accountSelfPattern =
  /^\/api\/v1\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformAccountSchema = z
  .object({
    username: z.string().trim().min(3).max(64),
    actorName: z.string().trim().min(2).max(100),
    roles: z
      .array(
        z.enum([
          "product_owner",
          "requirement_analyst",
          "developer",
          "administrator",
        ]),
      )
      .min(1)
      .max(4),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    links: z.object({ self: z.string().regex(accountSelfPattern) }).strict(),
  })
  .strict();
const accountListResponseSchema = z
  .object({ data: z.array(platformAccountSchema).max(500) })
  .strict();
const platformCustomerSelfPattern =
  /^\/api\/v1\/platform\/customers\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformProjectSelfPattern =
  /^\/api\/v1\/platform\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformRepositorySelfPattern =
  /^\/api\/v1\/platform\/repositories\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformRepositoryItemSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    gitUrl: z.string().trim().min(4).max(1_000),
    localPath: z.string().trim().min(1).max(1_000),
    defaultBranch: z.string().trim().min(1).max(200),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    links: z
      .object({ self: z.string().regex(platformRepositorySelfPattern) })
      .strict(),
  })
  .strict();
const platformProjectItemSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    repositories: z.array(platformRepositoryItemSchema).max(500),
    links: z
      .object({
        self: z.string().regex(platformProjectSelfPattern),
        actions: z.object({ createRepository: z.string() }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((project, context) => {
    if (
      project.links.actions.createRepository !==
      `${project.links.self}/repositories`
    ) {
      context.addIssue({
        code: "custom",
        path: ["links", "actions", "createRepository"],
        message: "代码仓库创建入口与项目不匹配",
      });
    }
  });
const platformCustomerItemSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(4).max(500),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    projects: z.array(platformProjectItemSchema).max(500),
    links: z
      .object({
        self: z.string().regex(platformCustomerSelfPattern),
        actions: z.object({ createProject: z.string() }).strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((customer, context) => {
    if (
      customer.links.actions.createProject !== `${customer.links.self}/projects`
    ) {
      context.addIssue({
        code: "custom",
        path: ["links", "actions", "createProject"],
        message: "项目创建入口与客户不匹配",
      });
    }
  });
const platformConfigurationResponseSchema = z
  .object({ data: z.array(platformCustomerItemSchema).max(500) })
  .strict();
const requirementSelfPattern =
  /^\/api\/v1\/requirements\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionSuffixes = {
  revise: "/revisions",
  submitConfirmation: "/submit-confirmation",
  confirm: "/confirm",
  startDelivery: "/start-delivery",
  accept: "/accept",
} as const;

const requirementLinksSchema = z
  .object({
    self: z.string().regex(requirementSelfPattern),
    history: z.string(),
    preview: z.string().optional(),
    actions: z
      .object({
        revise: z.string().optional(),
        submitConfirmation: z.string().optional(),
        confirm: z.string().optional(),
        startDelivery: z.string().optional(),
        accept: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((links, context) => {
    if (links.history !== `${links.self}/revisions`) {
      context.addIssue({
        code: "custom",
        path: ["history"],
        message: "版本链接与需求不匹配",
      });
    }
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

const requirementRevisionSchema = z
  .object({
    revision: z.number().int().min(1).max(100),
    version: z.string().regex(/^第 [1-9][0-9]{0,3} 版$/u),
    changedBy: z.string().trim().min(2).max(100),
    current: z.boolean(),
    confirmed: z.boolean(),
    changes: z.array(z.string().trim().min(2).max(30)).min(1).max(5),
    contentState: z.enum(["完整规格", "仅保留摘要"]),
    spec: requirementSpecSchema,
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
        revisions: z.array(requirementRevisionSchema).min(1).max(100),
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
        const currentRevisions = detail.revisions.filter(
          (revision) => revision.current,
        );
        const current = currentRevisions[0];
        const historyIsBound =
          currentRevisions.length === 1 &&
          current === detail.revisions.at(-1) &&
          detail.revisions.every(
            (revision, index) =>
              revision.revision === index + 1 &&
              revision.version === `第 ${index + 1} 版`,
          ) &&
          current?.version === detail.version &&
          JSON.stringify(current?.spec) === JSON.stringify(detail.spec);
        if (!historyIsBound) {
          context.addIssue({
            code: "custom",
            path: ["revisions"],
            message: "版本历史与当前需求不一致",
          });
        }
      }),
  })
  .strict();

const workerListResponseSchema = z
  .object({
    data: z.array(
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
    ),
    meta: z
      .object({
        connectedAccounts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        unlimited: z.literal(true),
      })
      .strict(),
    links: z
      .object({
        actions: z
          .object({
            connect: z.literal("/api/v1/worker-enrollments").optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((overview, context) => {
    if (overview.data.length !== overview.meta.connectedAccounts) {
      context.addIssue({
        code: "custom",
        path: ["meta"],
        message: "设备容量与列表不一致",
      });
    }
  });

const workerEnrollmentResponseSchema = z
  .object({
    data: z
      .object({
        schemaVersion: z.literal(1),
        enrollmentToken: z.string().min(32).max(256),
        expiresAt: z.iso.datetime(),
        exchangeUrl: z.literal("/api/v1/worker-enrollments/exchange"),
      })
      .strict(),
  })
  .strict();

const mcpInvocationSelfPattern =
  /^\/api\/v1\/mcp-invocations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const internalKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mcpServerSelfPattern =
  /^\/api\/v1\/extensions\/mcp\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mcpToolFormPattern = new RegExp(
  `${mcpServerSelfPattern.source.slice(0, -1)}/tools/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/form$`,
  "i",
);
const mcpToolCatalogResponseSchema = z
  .object({ data: McpToolCatalogSchema })
  .strict();
const mcpInvocationFormResponseSchema = z
  .object({ data: McpInvocationToolFormSchema })
  .strict();
const mcpInvocationListResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            title: z.string().trim().min(2).max(100),
            serviceName: z.string().trim().min(2).max(100),
            status: z.enum([
              "等待产品确认",
              "等待设备执行",
              "正在执行",
              "执行完成",
              "执行未成功",
              "已取消",
              "结果待人工核对",
            ]),
            requestedBy: z.string().trim().min(2).max(100),
            requestedAt: z.iso.datetime(),
            detail: z.string().trim().min(2).max(200),
            inputs: z
              .array(
                z
                  .object({
                    label: z.string().trim().min(2).max(100),
                    display: z.enum(["single", "list", "masked"]),
                    values: z.array(z.string().max(500)).min(1).max(50),
                    sensitive: z.boolean(),
                  })
                  .strict()
                  .superRefine((input, context) => {
                    if (
                      (input.sensitive && input.display !== "masked") ||
                      (!input.sensitive && input.display === "masked") ||
                      (input.display !== "list" && input.values.length !== 1) ||
                      (input.sensitive && input.values[0] !== "已安全提供")
                    ) {
                      context.addIssue({
                        code: "custom",
                        message: "业务参数展示方式不一致",
                      });
                    }
                  }),
              )
              .max(50),
            links: z
              .object({
                self: z.string().regex(mcpInvocationSelfPattern),
                actions: z
                  .object({
                    approve: z.string().optional(),
                    cancel: z.string().optional(),
                  })
                  .strict(),
              })
              .strict(),
          })
          .strict()
          .superRefine((item, context) => {
            const approve = item.links.actions.approve;
            const cancel = item.links.actions.cancel;
            if (
              approve !== undefined &&
              approve !== `${item.links.self}/approve`
            ) {
              context.addIssue({
                code: "custom",
                path: ["links", "actions", "approve"],
                message: "确认入口与当前操作不匹配",
              });
            }
            if (approve !== undefined && item.status !== "等待产品确认") {
              context.addIssue({
                code: "custom",
                path: ["links", "actions"],
                message: "确认入口与操作状态不一致",
              });
            }
            if (
              cancel !== undefined &&
              cancel !== `${item.links.self}/cancel`
            ) {
              context.addIssue({
                code: "custom",
                path: ["links", "actions", "cancel"],
                message: "取消入口与当前操作不匹配",
              });
            }
            if (
              cancel !== undefined &&
              !["等待产品确认", "等待设备执行", "已取消"].includes(item.status)
            ) {
              context.addIssue({
                code: "custom",
                path: ["links", "actions"],
                message: "取消入口与操作状态不一致",
              });
            }
          }),
      )
      .max(100),
  })
  .strict();

const knowledgeSelfPattern =
  /^\/api\/v1\/knowledge-bases\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const knowledgeSourceSelfPattern =
  /^\/api\/v1\/knowledge-bases\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/sources\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const knowledgeSourceSchema = z
  .object({
    title: z.string().trim().min(2).max(100),
    version: z.string().regex(/^第 [1-9][0-9]{0,2} 版$/),
    updatedBy: z.string().trim().min(2).max(100),
    updatedAt: z.iso.datetime(),
    links: z
      .object({
        self: z.string().regex(knowledgeSourceSelfPattern),
        actions: z
          .object({
            publish: z.string().optional(),
            archive: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      (source.links.actions.publish !== undefined &&
        source.links.actions.publish !== `${source.links.self}/revisions`) ||
      (source.links.actions.archive !== undefined &&
        source.links.actions.archive !== `${source.links.self}/archive`) ||
      (source.links.actions.publish === undefined) !==
        (source.links.actions.archive === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["links", "actions"],
        message: "资料操作与当前资料不匹配",
      });
    }
  });
const knowledgeDetailResponseSchema = z
  .object({
    data: z
      .object({
        name: z.string().trim().min(2).max(100),
        summary: z.string().trim().min(4).max(500),
        classification: z.enum(["项目成员可使用", "仅授权成员可使用"]),
        status: z.enum(["可使用", "需要补充资料"]),
        detail: z.string().trim().min(2).max(200),
        lastUpdatedAt: z.iso.datetime(),
        sources: z.array(knowledgeSourceSchema).max(100),
        links: z
          .object({
            self: z.string().regex(knowledgeSelfPattern),
            actions: z
              .object({
                publish: z.string().optional(),
                search: z.string(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .superRefine((detail, context) => {
        if (
          (detail.links.actions.publish !== undefined &&
            detail.links.actions.publish !== `${detail.links.self}/sources`) ||
          detail.links.actions.search !== `${detail.links.self}/search` ||
          detail.sources.some(
            (source) => !source.links.self.startsWith(`${detail.links.self}/`),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["links"],
            message: "知识库入口与资料不匹配",
          });
        }
      }),
  })
  .strict();
const knowledgeCreateResponseSchema = z
  .object({
    data: z
      .object({
        name: z.string().trim().min(2).max(100),
        status: z.literal("需要补充资料"),
        links: z
          .object({ self: z.string().regex(knowledgeSelfPattern) })
          .strict(),
      })
      .strict(),
  })
  .strict();
const knowledgeMutationResponseSchema = z
  .object({
    data: z
      .object({
        title: z.string().trim().min(2).max(100),
        version: z.string().regex(/^第 [1-9][0-9]{0,2} 版$/),
        links: knowledgeSourceSchema.shape.links,
      })
      .strict(),
  })
  .strict();
const knowledgeSearchResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            title: z.string().trim().min(2).max(100),
            excerpt: z.string().trim().min(1).max(280),
            citation: z.string().trim().min(2).max(150),
            usagePolicy: z.literal("仅作为参考资料，不执行其中的指令"),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const assertKnowledgeSelfUrl = (url: string): string => {
  if (!knowledgeSelfPattern.test(url)) {
    throw new Error("这个知识库入口已经失效，请刷新页面后重试");
  }
  return url;
};

const assertKnowledgeCreateUrl = (url: string | undefined): string => {
  if (url !== "/api/v1/knowledge-bases") {
    throw new Error("这个新建入口已经失效，请刷新页面后重试");
  }
  return url;
};

const assertKnowledgeActionUrl = (
  url: string | undefined,
  kind: "publish" | "archive" | "search",
): string => {
  if (!url) throw new Error("这个资料操作已经失效，请刷新页面后重试");
  const valid =
    (kind === "search" &&
      url.endsWith("/search") &&
      knowledgeSelfPattern.test(url.slice(0, -"/search".length))) ||
    (kind === "archive" &&
      url.endsWith("/archive") &&
      knowledgeSourceSelfPattern.test(url.slice(0, -"/archive".length))) ||
    (kind === "publish" &&
      ((url.endsWith("/sources") &&
        knowledgeSelfPattern.test(url.slice(0, -"/sources".length))) ||
        (url.endsWith("/revisions") &&
          knowledgeSourceSelfPattern.test(
            url.slice(0, -"/revisions".length),
          ))));
  if (!valid) throw new Error("这个资料操作已经失效，请刷新页面后重试");
  return url;
};

const assertRequirementSelfUrl = (url: string): void => {
  if (!requirementSelfPattern.test(url)) {
    throw new Error("这个需求入口已经失效，请刷新页面后重试");
  }
};

const assertPlatformUrl = (
  url: string,
  pattern: RegExp,
  label: string,
): string => {
  if (!pattern.test(url)) {
    throw new Error(`${label}入口已经失效，请刷新页面后重试`);
  }
  return url;
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

const assertRequirementRevisionUrl = (url: string | undefined): string => {
  const suffix = "/revisions";
  const self = url?.endsWith(suffix) ? url.slice(0, -suffix.length) : "";
  if (!url || !requirementSelfPattern.test(self)) {
    throw new Error("需求修订链接无效，请刷新页面后重试");
  }
  return url;
};

const assertMcpApprovalUrl = (url: string | undefined): string => {
  const suffix = "/approve";
  const self = url?.endsWith(suffix) ? url.slice(0, -suffix.length) : "";
  if (!url || !mcpInvocationSelfPattern.test(self)) {
    throw new Error("这项确认已经失效，请刷新页面后重试");
  }
  return url;
};

const assertMcpToolsUrl = (url: string): string => {
  const suffix = "/tools";
  const self = url.endsWith(suffix) ? url.slice(0, -suffix.length) : "";
  if (!mcpServerSelfPattern.test(self)) {
    throw new Error("这个外部服务入口已经失效，请刷新页面后重试");
  }
  return url;
};

const assertMcpToolFormUrl = (url: string): string => {
  if (!mcpToolFormPattern.test(url)) {
    throw new Error("这个外部操作入口已经失效，请刷新页面后重试");
  }
  return url;
};

const assertMcpRequestUrl = (url: string | undefined): string => {
  const suffix = "/requests";
  const formUrl = url?.endsWith(suffix)
    ? `${url.slice(0, -suffix.length)}/form`
    : "";
  if (!url || !mcpToolFormPattern.test(formUrl)) {
    throw new Error("这个外部操作表单已经失效，请刷新页面后重试");
  }
  return url;
};

const assertMcpCancellationUrl = (url: string | undefined): string => {
  const suffix = "/cancel";
  const self = url?.endsWith(suffix) ? url.slice(0, -suffix.length) : "";
  if (!url || !mcpInvocationSelfPattern.test(self)) {
    throw new Error("这项取消操作已经失效，请刷新页面后重试");
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
    if (options.authorization && !headers.has("Authorization")) {
      headers.set("Authorization", options.authorization);
    }
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (!response.ok) {
      throw new ForgeXHttpError(
        response.status,
        await readErrorMessage(response),
      );
    }
    return response;
  };

  return {
    startSession: async (input) => {
      const username = input.username.trim().toLowerCase();
      if (
        username.length < 3 ||
        username.length > 64 ||
        !usernamePattern.test(username) ||
        input.password.length < 12 ||
        input.password.length > 128
      ) {
        throw new Error("账号或密码格式不正确，请检查后重试");
      }
      const response = await request("/api/v1/session", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          username,
          password: input.password,
        }),
      });
      const parsed = sessionResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("登录响应格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    getSession: async () => {
      const response = await request("/api/v1/session");
      const parsed = sessionResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("登录状态格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    endSession: async () => {
      await request("/api/v1/session", { method: "DELETE" });
    },
    listAccounts: async () => {
      const response = await request("/api/v1/accounts");
      const parsed = accountListResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("账号列表格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    createAccount: async (input) => {
      await request("/api/v1/accounts", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, ...input }),
      });
    },
    updateAccount: async (selfUrl, expectedRevision, input) => {
      if (!accountSelfPattern.test(selfUrl)) {
        throw new Error("账号编辑入口已经失效，请刷新后重试");
      }
      await request(selfUrl, {
        method: "PATCH",
        body: JSON.stringify({
          schemaVersion: 1,
          expectedRevision,
          ...input,
        }),
      });
    },
    deleteAccount: async (selfUrl, expectedRevision) => {
      if (!accountSelfPattern.test(selfUrl)) {
        throw new Error("账号删除入口已经失效，请刷新后重试");
      }
      await request(selfUrl, {
        method: "DELETE",
        body: JSON.stringify({ schemaVersion: 1, expectedRevision }),
      });
    },
    listPlatformConfiguration: async () => {
      const response = await request("/api/v1/platform/customers");
      const parsed = platformConfigurationResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("客户与项目配置格式不正确，请联系管理员");
      }
      return { customers: parsed.data.data };
    },
    createPlatformCustomer: async (input) => {
      await request("/api/v1/platform/customers", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, ...input }),
      });
    },
    updatePlatformCustomer: async (selfUrl, expectedRevision, input) => {
      await request(
        assertPlatformUrl(selfUrl, platformCustomerSelfPattern, "客户编辑"),
        {
          method: "PATCH",
          body: JSON.stringify({
            schemaVersion: 1,
            expectedRevision,
            ...input,
          }),
        },
      );
    },
    deletePlatformCustomer: async (selfUrl, expectedRevision) => {
      await request(
        assertPlatformUrl(selfUrl, platformCustomerSelfPattern, "客户删除"),
        {
          method: "DELETE",
          body: JSON.stringify({ schemaVersion: 1, expectedRevision }),
        },
      );
    },
    createPlatformProject: async (actionUrl, input) => {
      const self = actionUrl.endsWith("/projects")
        ? actionUrl.slice(0, -"/projects".length)
        : "";
      assertPlatformUrl(self, platformCustomerSelfPattern, "项目创建");
      await request(actionUrl, {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, ...input }),
      });
    },
    updatePlatformProject: async (selfUrl, expectedRevision, input) => {
      await request(
        assertPlatformUrl(selfUrl, platformProjectSelfPattern, "项目编辑"),
        {
          method: "PATCH",
          body: JSON.stringify({
            schemaVersion: 1,
            expectedRevision,
            ...input,
          }),
        },
      );
    },
    deletePlatformProject: async (selfUrl, expectedRevision) => {
      await request(
        assertPlatformUrl(selfUrl, platformProjectSelfPattern, "项目删除"),
        {
          method: "DELETE",
          body: JSON.stringify({ schemaVersion: 1, expectedRevision }),
        },
      );
    },
    createProjectRepository: async (actionUrl, input) => {
      const self = actionUrl.endsWith("/repositories")
        ? actionUrl.slice(0, -"/repositories".length)
        : "";
      assertPlatformUrl(self, platformProjectSelfPattern, "代码仓库创建");
      await request(actionUrl, {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, ...input }),
      });
    },
    updateProjectRepository: async (selfUrl, expectedRevision, input) => {
      await request(
        assertPlatformUrl(
          selfUrl,
          platformRepositorySelfPattern,
          "代码仓库编辑",
        ),
        {
          method: "PATCH",
          body: JSON.stringify({
            schemaVersion: 1,
            expectedRevision,
            ...input,
          }),
        },
      );
    },
    deleteProjectRepository: async (selfUrl, expectedRevision) => {
      await request(
        assertPlatformUrl(
          selfUrl,
          platformRepositorySelfPattern,
          "代码仓库删除",
        ),
        {
          method: "DELETE",
          body: JSON.stringify({ schemaVersion: 1, expectedRevision }),
        },
      );
    },
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
        ...(parsed.data.links.actions.connect
          ? { connectAction: parsed.data.links.actions.connect }
          : {}),
      };
    },
    connectWorker: async (actionUrl, input) => {
      if (actionUrl !== "/api/v1/worker-enrollments") {
        throw new Error("设备连接入口已经失效，请刷新页面后重试");
      }
      const response = await request(actionUrl, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          deviceName: input.deviceName,
          accountName: input.accountName,
        }),
      });
      const parsed = workerEnrollmentResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("设备接入码响应格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    listExtensions: async () => {
      const response = await request("/api/v1/extensions");
      const parsed = ExtensionCatalogResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("扩展目录格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    getMcpToolCatalog: async (toolsUrl) => {
      const trustedToolsUrl = assertMcpToolsUrl(toolsUrl);
      const response = await request(trustedToolsUrl);
      const parsed = mcpToolCatalogResponseSchema.safeParse(
        await response.json(),
      );
      const formLinks = parsed.success
        ? parsed.data.data.tools.map((tool) => tool.links.form)
        : [];
      if (
        !parsed.success ||
        new Set(formLinks).size !== formLinks.length ||
        formLinks.some(
          (form) =>
            !form.startsWith(`${trustedToolsUrl}/`) ||
            !mcpToolFormPattern.test(form),
        )
      ) {
        throw new Error("外部服务目录格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    getMcpInvocationForm: async (formUrl) => {
      const trustedFormUrl = assertMcpToolFormUrl(formUrl);
      const response = await request(trustedFormUrl);
      const parsed = mcpInvocationFormResponseSchema.safeParse(
        await response.json(),
      );
      const expectedRequestUrl = `${trustedFormUrl.slice(0, -"/form".length)}/requests`;
      if (
        !parsed.success ||
        parsed.data.data.links.request !== expectedRequestUrl
      ) {
        throw new Error("外部操作表单格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    requestMcpInvocation: async (actionUrl, requestKey, inputs) => {
      if (!internalKeyPattern.test(requestKey)) {
        throw new Error("这次外部操作请求已经失效，请重新打开表单");
      }
      await request(assertMcpRequestUrl(actionUrl), {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          requestKey,
          inputs,
        }),
      });
    },
    listMcpInvocations: async () => {
      const response = await request("/api/v1/mcp-invocations");
      const parsed = mcpInvocationListResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("操作确认列表格式不正确，请联系管理员");
      }
      return parsed.data.data;
    },
    getKnowledgeBase: async (selfUrl) => {
      const url = assertKnowledgeSelfUrl(selfUrl);
      const response = await request(url);
      const parsed = knowledgeDetailResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("知识库详情格式不正确，请联系管理员");
      }
      if (parsed.data.data.links.self !== url) {
        throw new Error("知识库详情与当前资料不匹配，请刷新页面后重试");
      }
      return parsed.data.data;
    },
    createKnowledgeBase: async (actionUrl, input) => {
      const response = await request(assertKnowledgeCreateUrl(actionUrl), {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          requestKey: crypto.randomUUID(),
          ...input,
        }),
      });
      const parsed = knowledgeCreateResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("新建知识库响应格式不正确，请联系管理员");
      }
      return parsed.data.data.links.self;
    },
    publishKnowledgeSource: async (actionUrl, input) => {
      const response = await request(
        assertKnowledgeActionUrl(actionUrl, "publish"),
        {
          method: "POST",
          body: JSON.stringify({
            schemaVersion: 1,
            requestKey: crypto.randomUUID(),
            ...input,
          }),
        },
      );
      const parsed = knowledgeMutationResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("资料发布响应格式不正确，请联系管理员");
      }
    },
    archiveKnowledgeSource: async (actionUrl) => {
      await request(assertKnowledgeActionUrl(actionUrl, "archive"), {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          requestKey: crypto.randomUUID(),
        }),
      });
    },
    searchKnowledgeBase: async (actionUrl, query) => {
      const response = await request(
        assertKnowledgeActionUrl(actionUrl, "search"),
        {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 1, query, limit: 10 }),
        },
      );
      const parsed = knowledgeSearchResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("知识检索结果格式不正确，请联系管理员");
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
    reviseRequirement: async (actionUrl, spec, expectedRevision) => {
      await request(assertRequirementRevisionUrl(actionUrl), {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          expectedRevision,
          spec,
        }),
      });
    },
    runRequirementAction: async (actionUrl, body) => {
      await request(assertRequirementActionUrl(actionUrl), {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    approveMcpInvocation: async (actionUrl) => {
      await request(assertMcpApprovalUrl(actionUrl), { method: "POST" });
    },
    cancelMcpInvocation: async (actionUrl) => {
      await request(assertMcpCancellationUrl(actionUrl), { method: "POST" });
    },
  };
};
