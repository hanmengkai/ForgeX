import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ExtensionCatalogItem } from "./api.js";

interface SkillSelectionDialogProps {
  skills: ExtensionCatalogItem[];
  busy: boolean;
  onClose(): void;
  onConfirm(skillKeys: string[]): Promise<boolean>;
}

const skillKeyFromLink = (selfUrl: string) => {
  const match = selfUrl.match(
    /^\/api\/v1\/(?:projects\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/)?extensions\/skills\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu,
  );
  if (!match?.[1]) throw new Error("团队能力目录返回了无法识别的链接");
  return match[1].toLowerCase();
};

export function SkillSelectionDialog({
  skills,
  busy,
  onClose,
  onConfirm,
}: SkillSelectionDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  const requestClose = () => {
    if (!busyRef.current) onCloseRef.current();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const backdrop = backdropRef.current;
    const backgroundElements = backdrop
      ? [...(backdrop.parentElement?.children ?? [])].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== backdrop,
        )
      : [];
    const previousInertValues = backgroundElements.map((element) =>
      element.hasAttribute("inert"),
    );
    for (const element of backgroundElements) element.setAttribute("inert", "");
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    (
      dialog?.querySelector<HTMLElement>("input") ??
      dialog?.querySelector<HTMLElement>(focusableSelector) ??
      dialog
    )?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      backgroundElements.forEach((element, index) => {
        if (previousInertValues[index]) element.setAttribute("inert", "");
        else element.removeAttribute("inert");
      });
      previousFocusRef.current?.focus();
    };
  }, []);

  const toggle = (skillKey: string, checked: boolean) => {
    setError(null);
    setSelected((current) => {
      if (!checked) return current.filter((item) => item !== skillKey);
      if (current.includes(skillKey)) return current;
      if (current.length >= 10) {
        setError("一次交付最多选择 10 项团队能力");
        return current;
      }
      return [...current, skillKey];
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (await onConfirm(selected)) onCloseRef.current();
    else setError("交付安排没有完成，请检查页面提示后重试");
  };

  return (
    <div
      ref={backdropRef}
      className="dialog-backdrop"
      onMouseDown={requestClose}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-selection-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">本次交付上下文</span>
            <h2 id="skill-selection-title">选择团队能力</h2>
            <p>只把本次确实需要的已验证工作方法交给设备，最多选择 10 项。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            disabled={busy}
            onClick={requestClose}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">关闭</span>
          </button>
        </div>
        <form onSubmit={submit}>
          {skills.length === 0 ? (
            <div className="empty-state compact">
              <h3>没有已激活的团队能力</h3>
              <p>仍可不附加团队能力，按已确认需求开始交付。</p>
            </div>
          ) : (
            <fieldset className="skill-selection-list">
              <legend>已选择 {selected.length} / 10 项</legend>
              {skills.map((skill) => {
                const skillKey = skillKeyFromLink(skill.links.self);
                return (
                  <label key={skill.links.self}>
                    <input
                      type="checkbox"
                      checked={selected.includes(skillKey)}
                      disabled={busy}
                      onChange={(event) =>
                        toggle(skillKey, event.target.checked)
                      }
                    />
                    <span>
                      <strong>{skill.name}</strong>
                      <small>{skill.summary}</small>
                      <small>{skill.detail}</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={requestClose}
            >
              返回
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "正在安排…" : "确认并开始交付"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
