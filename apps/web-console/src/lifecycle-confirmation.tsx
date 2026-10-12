import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { LifecycleView, LifecycleRole } from "@forgex/contracts/lifecycle";
import { lifecycleRoleNames } from "./lifecycle-presentation.js";
export function LifecycleConfirmation({
  flow,
  role,
  decision,
  reason,
  busy,
  onCancel,
  onConfirm,
}: {
  flow: LifecycleView;
  role: LifecycleRole;
  decision: "approve" | "reject" | "object";
  reason: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    original = useRef(document.activeElement as HTMLElement | null),
    busyRef = useRef(busy);
  busyRef.current = busy;
  const title =
    decision === "approve"
      ? "确认审核通过"
      : decision === "reject"
        ? "确认驳回返工"
        : "确认提出异议";
  useEffect(() => {
    const close = () => {
      if (!busyRef.current) onCancel();
    };
    const background = [...document.body.children].filter(
      (e): e is HTMLElement =>
        e instanceof HTMLElement && !e.contains(ref.current),
    );
    const old = background.map((e) => e.hasAttribute("inert"));
    background.forEach((e) => e.setAttribute("inert", ""));
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key !== "Tab") return;
      const controls = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[tabindex="0"]',
        ) ?? []),
      ];
      const first = controls[0],
        last = controls.at(-1);
      if (!first) {
        e.preventDefault();
        ref.current?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      background.forEach((e, i) => {
        if (!old[i]) e.removeAttribute("inert");
      });
      if (original.current?.isConnected) original.current.focus();
    };
  }, [onCancel]);
  return createPortal(
    <div className="dialog-backdrop delivery-confirm-backdrop">
      <div
        className="dialog delivery-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delivery-confirm-title"
        ref={ref}
        tabIndex={-1}
      >
        <span className="eyebrow">确认本次处理</span>
        <h2 id="delivery-confirm-title">{title}</h2>
        <p className="delivery-confirm-title">{flow.title}</p>
        <dl>
          <div>
            <dt>审核对象</dt>
            <dd>{flow.stageLabel}</dd>
          </div>
          <div>
            <dt>方案版本</dt>
            <dd>
              需求第 {flow.requirementVersion} 版 · 设计第 {flow.designVersion}{" "}
              版
            </dd>
          </div>
          <div>
            <dt>确认身份</dt>
            <dd>{lifecycleRoleNames[role]}</dd>
          </div>
        </dl>
        <blockquote>{reason}</blockquote>
        <p>本次决定将写入审批记录。后续步骤仍由各岗位按权限确认。</p>
        <div className="dialog-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            继续核对
          </button>
          <button
            className={`button ${decision === "reject" ? "danger" : "primary"}`}
            type="button"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "正在提交…" : "确认提交"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
