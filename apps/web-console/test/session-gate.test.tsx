// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGate, type ForgeXClient } from "../src/index.js";

const createClient = (): ForgeXClient => ({
  startSession: vi.fn().mockResolvedValue({ actorName: "产品负责人" }),
  getSession: vi.fn().mockRejectedValue(new Error("请先登录")),
  endSession: vi.fn().mockResolvedValue(undefined),
  listRequirements: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  listWorkers: vi.fn().mockResolvedValue({
    workers: [],
    capacity: { connectedAccounts: 0, maxAccounts: 5, availableSlots: 5 },
  }),
  connectWorker: vi.fn(),
  listExtensions: vi.fn().mockResolvedValue({
    businessKnowledge: [],
    teamCapabilities: [],
    externalTools: [],
  }),
  listMcpInvocations: vi.fn().mockResolvedValue([]),
  getKnowledgeBase: vi.fn(),
  createKnowledgeBase: vi.fn(),
  publishKnowledgeSource: vi.fn(),
  archiveKnowledgeSource: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  getRequirement: vi.fn(),
  createRequirement: vi.fn(),
  runRequirementAction: vi.fn(),
  approveMcpInvocation: vi.fn(),
  cancelMcpInvocation: vi.fn(),
});

afterEach(cleanup);

describe("SessionGate", () => {
  it("引导用户登录、清除输入令牌，并可从工作台安全注销", async () => {
    const client = createClient();
    render(<SessionGate client={client} projectName="访客项目" />);

    const tokenInput = await screen.findByLabelText("访问令牌");
    await userEvent.type(
      tokenInput,
      "one-time-access-token-with-enough-entropy",
    );
    await userEvent.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(client.startSession).toHaveBeenCalledWith(
      "one-time-access-token-with-enough-entropy",
    );
    expect(await screen.findByText("从第一个业务目标开始")).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/one-time-access-token/u)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(client.endSession).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("访问令牌")).toBeInTheDocument();
  });
});
