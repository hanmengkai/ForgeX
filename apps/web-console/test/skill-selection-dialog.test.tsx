// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionCatalogItem } from "../src/api.js";
import { SkillSelectionDialog } from "../src/skill-selection-dialog.js";

afterEach(() => {
  document.body.innerHTML = "";
});

const skill: ExtensionCatalogItem = {
  name: "需求风险检查",
  summary: "在开始交付前识别遗漏和歧义",
  status: "可使用",
  detail: "版本 1.0.0",
  supportingText: "已通过独立评测",
  links: {
    self: "/api/v1/extensions/skills/44444444-4444-4444-8444-444444444444",
  },
};

const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("SkillSelectionDialog", () => {
  it("限制焦点和背景操作，提交期间不可关闭并在完成后恢复入口焦点", async () => {
    const user = userEvent.setup();
    const confirmation = deferred();
    const onConfirm = vi.fn((_skillKeys: string[]) => confirmation.promise);

    function Harness() {
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      return (
        <>
          <main>
            <button type="button" onClick={() => setOpen(true)}>
              安排 AI 开始实现
            </button>
          </main>
          {open ? (
            <SkillSelectionDialog
              skills={[skill]}
              busy={busy}
              onClose={() => setOpen(false)}
              onConfirm={async (skillKeys) => {
                setBusy(true);
                const completed = await onConfirm(skillKeys);
                setBusy(false);
                return completed;
              }}
            />
          ) : null}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "安排 AI 开始实现" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "选择团队能力" });
    const checkbox = screen.getByRole("checkbox", { name: /需求风险检查/ });
    const close = screen.getByRole("button", { name: "关闭" });
    const confirm = screen.getByRole("button", {
      name: "确认并开始交付",
    });
    const applicationRoot = opener.closest("main")?.parentElement;
    expect(applicationRoot).toHaveAttribute("inert");
    expect(checkbox).toHaveFocus();

    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.click(checkbox);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith([
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(close).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(dialog.closest(".dialog-backdrop")!);
    expect(dialog).toBeInTheDocument();

    await act(async () => confirmation.resolve(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
    expect(applicationRoot).not.toHaveAttribute("inert");
  });
});
