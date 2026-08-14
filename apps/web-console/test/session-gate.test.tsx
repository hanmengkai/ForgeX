// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGate, type ForgeXClient } from "../src/index.js";

const createClient = (): ForgeXClient => ({
  startSession: vi.fn().mockResolvedValue({
    actorName: "产品负责人",
    username: "product.owner",
    roles: ["product_owner"],
  }),
  getSession: vi.fn().mockRejectedValue(new Error("请先登录")),
  endSession: vi.fn().mockResolvedValue(undefined),
  listAccounts: vi.fn().mockResolvedValue([]),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  listPlatformConfiguration: vi.fn().mockResolvedValue({ customers: [] }),
  listRequirementContexts: vi.fn().mockResolvedValue({ customers: [] }),
  createPlatformCustomer: vi.fn(),
  updatePlatformCustomer: vi.fn(),
  deletePlatformCustomer: vi.fn(),
  createPlatformProject: vi.fn(),
  updatePlatformProject: vi.fn(),
  deletePlatformProject: vi.fn(),
  createProjectRepository: vi.fn(),
  updateProjectRepository: vi.fn(),
  deleteProjectRepository: vi.fn(),
  getProjectInitialization: vi.fn(),
  initializeProject: vi.fn(),
  listRequirements: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  listWorkers: vi.fn().mockResolvedValue({
    workers: [],
    capacity: { connectedAccounts: 0, unlimited: true },
  }),
  connectWorker: vi.fn(),
  listExtensions: vi.fn().mockResolvedValue({
    businessKnowledge: [],
    teamCapabilities: [],
    externalTools: [],
  }),
  getMcpToolCatalog: vi.fn(),
  getMcpInvocationForm: vi.fn(),
  requestMcpInvocation: vi.fn(),
  listMcpInvocations: vi.fn().mockResolvedValue([]),
  getKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  publishKnowledgeSource: vi.fn(),
  archiveKnowledgeSource: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  getRequirement: vi.fn(),
  createRequirement: vi.fn(),
  reviseRequirement: vi.fn(),
  deleteRequirement: vi.fn(),
  runRequirementAction: vi.fn(),
  approveMcpInvocation: vi.fn(),
  cancelMcpInvocation: vi.fn(),
});

afterEach(cleanup);

describe("SessionGate", () => {
  it("使用账号密码登录、清除密码，并可从顶部安全注销", async () => {
    const client = createClient();
    render(<SessionGate client={client} projectName="访客项目" />);

    const usernameInput = await screen.findByLabelText("账号");
    const passwordInput = screen.getByLabelText("密码");
    expect(passwordInput).toHaveAttribute("minlength", "6");
    await userEvent.type(usernameInput, "product.owner");
    await userEvent.type(passwordInput, "123456");
    await userEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(client.startSession).toHaveBeenCalledWith({
      username: "product.owner",
      password: "123456",
    });
    expect(await screen.findByText("ForgeX 运行总览")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("123456")).toBeNull();
    expect(screen.getByText("product.owner")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(client.endSession).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("账号")).toBeInTheDocument();
  });
});
