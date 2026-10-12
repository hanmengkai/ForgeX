// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { WorkerCenter } from "../src/worker-center.js";
import type { ForgeXClient } from "../src/api.js";
afterEach(cleanup);
describe("执行器状态可读且不伪造登录", () => {
  it("空闲但未核对登录不计入可接任务；没有心跳的执行器展示尚未连接", async () => {
    const view = {
      schemaVersion: 1,
      executorKey: "11111111-1111-4111-8111-111111111111",
      displayName: "开发执行器",
      provider: "codex",
      loginState: "unknown",
      status: "idle",
      lastSeenAt: "2026-10-12T04:00:00.000Z",
      capabilities: ["AI 开发与自测"],
      currentWork: null,
      identityFingerprint: "a".repeat(64),
    };
    const client = {
      listWorkers: vi.fn(async () => ({
        workers: [],
        capacity: { connectedAccounts: 0, unlimited: true },
        connectAction: null,
      })),
      lifecycle: {
        workers: vi.fn(async () => [
          view,
          {
            ...view,
            executorKey: "22222222-2222-4222-8222-222222222222",
            displayName: "测试执行器",
            status: "not_connected",
            lastSeenAt: null,
          },
        ]),
      },
    } as unknown as ForgeXClient;
    render(<WorkerCenter client={client} />);
    const fleet = await screen.findByRole("region", { name: "交付执行器" });
    expect(within(fleet).getByText("尚未连接")).toBeInTheDocument();
    expect(within(fleet).queryByText("本机 Codex 已登录")).toBeNull();
    const metric = within(fleet).getByText("可接新任务").parentElement!;
    expect(metric).toHaveTextContent("0");
    expect(within(fleet).getAllByText("尚未核对，不计入可接任务")).toHaveLength(
      2,
    );
  });
});
