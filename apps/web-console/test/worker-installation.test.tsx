// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerCenter, type ForgeXClient } from "../src/index.js";

afterEach(cleanup);

describe("ForgeX Agent 安装入口", () => {
  it("在无设备时仍提供真实下载链接和四步安装说明", async () => {
    const client = {
      listWorkers: vi.fn().mockResolvedValue({
        workers: [],
        capacity: {
          connectedAccounts: 0,
          maxAccounts: 5,
          availableSlots: 5,
        },
        connectAction: "/api/v1/worker-enrollments",
      }),
      connectWorker: vi.fn(),
    } as unknown as ForgeXClient;

    render(<WorkerCenter client={client} />);

    expect(
      await screen.findByRole("heading", { name: "安装 ForgeX Agent" }),
    ).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "下载 Agent 安装包" });
    expect(download).toHaveAttribute(
      "href",
      "https://gitee.com/hmk_855_admin/forge-x/repository/archive/master.zip",
    );
    expect(screen.getByText("1. 下载并解压")).toBeInTheDocument();
    expect(screen.getByText("2. 准备运行环境")).toBeInTheDocument();
    expect(screen.getByText("3. 生成接入码")).toBeInTheDocument();
    expect(screen.getByText("4. 启动并验证")).toBeInTheDocument();
  });
});
