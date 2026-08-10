import { useEffect, useRef, useState, type FormEvent } from "react";

import type { ForgeXClient, RequirementSpecInput } from "./api.js";

interface CreateRequirementDialogProps {
  client: ForgeXClient;
  onClose(): void;
  onCreated(): Promise<void>;
}

const toRequirementSpec = (
  title: string,
  goal: string,
  acceptanceText: string,
  userStoryText: string,
  openQuestionText: string,
): RequirementSpecInput => ({
  schemaVersion: 1,
  title: title.trim(),
  goal: goal.trim(),
  userStories: userStoryText
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((story) => {
      const parts = story.split(/[|｜]/u).map((item) => item.trim());
      const [role = "", need = "", value = ""] =
        parts.length === 3 ? parts : [];
      return { role, need, value };
    }),
  acceptanceCriteria: acceptanceText
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((criterion) => ({
      title: criterion,
      description: `验收时确认：${criterion}`,
      priority: "must" as const,
    })),
  openQuestions: openQuestionText
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean),
});

export function CreateRequirementDialog({
  client,
  onClose,
  onCreated,
}: CreateRequirementDialogProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [userStories, setUserStories] = useState("");
  const [openQuestions, setOpenQuestions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const requestClose = () => {
    if (!savingRef.current) onClose();
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
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => {
      const first =
        dialog?.querySelector<HTMLElement>("#requirement-title") ??
        dialog?.querySelector<HTMLElement>(focusableSelector);
      (first ?? dialog)?.focus();
    };
    focusFirst();

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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    const spec = toRequirementSpec(
      title,
      goal,
      acceptance,
      userStories,
      openQuestions,
    );
    if (
      spec.title.length < 2 ||
      spec.goal.length < 4 ||
      spec.acceptanceCriteria.length === 0 ||
      spec.userStories.some(
        (story) =>
          story.role.length < 2 ||
          story.need.length < 2 ||
          story.value.length < 2,
      )
    ) {
      setError("请填写需求名称、要解决的问题和至少一条完成标准");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await client.createRequirement(spec);
      await onCreated();
      savingRef.current = false;
      setSaving(false);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "暂时无法保存，请稍后再试",
      );
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      className="dialog-backdrop"
      data-testid="dialog-backdrop"
      onMouseDown={requestClose}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-requirement-title"
        aria-busy={saving}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">从业务目标开始</span>
            <h2 id="create-requirement-title">新建需求</h2>
            <p>先说清楚想解决什么，技术方案交给后续流程整理。</p>
          </div>
          <button
            className="icon-button"
            type="button"
            disabled={saving}
            onClick={requestClose}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">关闭</span>
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="requirement-title">需求名称</label>
            <input
              id="requirement-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：访客预约"
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="field">
            <label htmlFor="requirement-goal">希望解决什么问题？</label>
            <textarea
              id="requirement-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="描述使用者遇到的问题，以及希望带来的变化"
              rows={4}
              disabled={saving}
            />
          </div>
          <div className="field">
            <label htmlFor="requirement-user-stories">谁会使用？</label>
            <textarea
              id="requirement-user-stories"
              value={userStories}
              onChange={(event) => setUserStories(event.target.value)}
              placeholder={
                "每行填写：角色｜想做什么｜带来什么价值\n例如：物业前台｜查看今日访客｜提前做好接待准备"
              }
              rows={3}
              aria-describedby="requirement-user-stories-help"
              disabled={saving}
            />
            <small id="requirement-user-stories-help">
              用户故事可以暂时留空；填写时请用“｜”分隔三部分。
            </small>
          </div>
          <div className="field">
            <label htmlFor="requirement-acceptance">怎么才算完成？</label>
            <textarea
              id="requirement-acceptance"
              value={acceptance}
              onChange={(event) => setAcceptance(event.target.value)}
              placeholder={"每行写一条可验证的结果\n例如：访客可以提交预约"}
              rows={4}
              aria-describedby="requirement-acceptance-help"
              disabled={saving}
            />
            <small id="requirement-acceptance-help">
              一行一条，后续会与真实测试证据逐项对应。
            </small>
          </div>
          <div className="field">
            <label htmlFor="requirement-open-questions">
              还有哪些问题需要澄清？
            </label>
            <textarea
              id="requirement-open-questions"
              value={openQuestions}
              onChange={(event) => setOpenQuestions(event.target.value)}
              placeholder={"每行写一个尚未确定的问题"}
              rows={3}
              disabled={saving}
            />
          </div>

          {error ? (
            <div className="form-error" role="alert" aria-label={error}>
              {error}
            </div>
          ) : null}

          <div className="dialog-actions">
            <button
              className="button secondary"
              type="button"
              disabled={saving}
              onClick={requestClose}
            >
              取消
            </button>
            <button className="button primary" type="submit" disabled={saving}>
              {saving ? "正在保存…" : "保存并开始整理"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
