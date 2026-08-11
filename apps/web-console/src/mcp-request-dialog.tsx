import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  McpInvocationFormField,
  McpInvocationToolForm,
  McpToolCatalog,
} from "@forgex/contracts";

import type { ForgeXClient } from "./api.js";

interface McpRequestDialogProps {
  client: ForgeXClient;
  toolsUrl: string;
  onClose(): void;
  onSubmitted(): void;
}

const valueForField = (field: McpInvocationFormField, raw: string): unknown => {
  const constraints = field.constraints ?? {};
  const assertNumberConstraints = (value: number) => {
    if (constraints.minimum !== undefined && value < constraints.minimum) {
      throw new Error(`${field.label}不能小于 ${constraints.minimum}`);
    }
    if (
      constraints.exclusiveMinimum !== undefined &&
      value <= constraints.exclusiveMinimum
    ) {
      throw new Error(`${field.label}必须大于 ${constraints.exclusiveMinimum}`);
    }
    if (constraints.maximum !== undefined && value > constraints.maximum) {
      throw new Error(`${field.label}不能大于 ${constraints.maximum}`);
    }
    if (
      constraints.exclusiveMaximum !== undefined &&
      value >= constraints.exclusiveMaximum
    ) {
      throw new Error(`${field.label}必须小于 ${constraints.exclusiveMaximum}`);
    }
    if (constraints.multipleOf !== undefined) {
      const quotient = value / constraints.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-10) {
        throw new Error(`${field.label}需要按 ${constraints.multipleOf} 递增`);
      }
    }
  };
  if (field.kind === "integer") {
    const value = Number(raw);
    if (!Number.isSafeInteger(value))
      throw new Error(`${field.label}需要填写整数`);
    assertNumberConstraints(value);
    return value;
  }
  if (field.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${field.label}需要填写数字`);
    assertNumberConstraints(value);
    return value;
  }
  if (field.kind === "boolean") {
    if (!["true", "false"].includes(raw)) {
      throw new Error(`${field.label}需要选择是或否`);
    }
    return raw === "true";
  }
  if (field.kind === "select") {
    if (!field.options.some((option) => option.optionKey === raw)) {
      throw new Error(`${field.label}需要选择一个有效选项`);
    }
    return raw;
  }
  if (field.kind === "text_list") {
    const values = raw.split(/\r?\n/u).filter((value) => value.length > 0);
    if (values.length === 0) throw new Error(`${field.label}至少填写一项`);
    if (
      constraints.minItems !== undefined &&
      values.length < constraints.minItems
    ) {
      throw new Error(`${field.label}至少填写 ${constraints.minItems} 项`);
    }
    if (
      constraints.maxItems !== undefined &&
      values.length > constraints.maxItems
    ) {
      throw new Error(`${field.label}最多填写 ${constraints.maxItems} 项`);
    }
    if (
      constraints.itemMinLength !== undefined &&
      values.some((value) => value.length < constraints.itemMinLength!)
    ) {
      throw new Error(`${field.label}每项内容过短`);
    }
    if (
      constraints.itemMaxLength !== undefined &&
      values.some((value) => value.length > constraints.itemMaxLength!)
    ) {
      throw new Error(`${field.label}每项内容过长`);
    }
    return values;
  }
  if (
    constraints.minLength !== undefined &&
    raw.length < constraints.minLength
  ) {
    throw new Error(`${field.label}至少填写 ${constraints.minLength} 个字符`);
  }
  if (
    constraints.maxLength !== undefined &&
    raw.length > constraints.maxLength
  ) {
    throw new Error(`${field.label}最多填写 ${constraints.maxLength} 个字符`);
  }
  return raw;
};

function BusinessField({
  field,
  value,
  busy,
  onChange,
}: {
  field: McpInvocationFormField;
  value: string;
  busy: boolean;
  onChange(value: string): void;
}) {
  const common = {
    id: `mcp-field-${field.fieldKey}`,
    disabled: busy,
    required: field.required,
    value,
    onChange: (
      event: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => onChange(event.target.value),
  };
  return (
    <label className="field" htmlFor={common.id}>
      {field.label}
      {field.kind === "boolean" ? (
        <select {...common}>
          <option value="">请选择</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : field.kind === "select" ? (
        <select {...common}>
          <option value="">请选择</option>
          {field.options.map((option) => (
            <option key={option.optionKey} value={option.optionKey}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "text_list" ? (
        <textarea {...common} rows={4} placeholder="每行填写一项" />
      ) : (
        <input
          {...common}
          type={field.kind === "text" ? "text" : "number"}
          minLength={field.constraints?.minLength}
          maxLength={field.constraints?.maxLength}
          min={field.constraints?.minimum}
          max={field.constraints?.maximum}
          step={
            field.constraints?.multipleOf ??
            (field.kind === "integer"
              ? "1"
              : field.kind === "number"
                ? "any"
                : undefined)
          }
        />
      )}
      <small>{field.description}</small>
    </label>
  );
}

export function McpRequestDialog({
  client,
  toolsUrl,
  onClose,
  onSubmitted,
}: McpRequestDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const requestKeyRef = useRef(crypto.randomUUID());
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [catalog, setCatalog] = useState<McpToolCatalog | null>(null);
  const [form, setForm] = useState<McpInvocationToolForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  const requestClose = () => {
    if (!busyRef.current) onCloseRef.current();
  };

  useEffect(() => {
    let active = true;
    void client
      .getMcpToolCatalog(toolsUrl)
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error ? caught.message : "暂时无法读取外部服务",
          );
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, toolsUrl]);

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
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    (dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog)?.focus();
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

  const chooseTool = async (tool: McpToolCatalog["tools"][number]) => {
    setBusy(true);
    setError(null);
    try {
      const nextForm = await client.getMcpInvocationForm(tool.links.form);
      if (
        nextForm.serviceName !== catalog?.serviceName ||
        nextForm.title !== tool.title ||
        nextForm.description !== tool.description ||
        nextForm.impact !== tool.impact ||
        nextForm.confirmation !== tool.confirmation
      ) {
        throw new Error("外部操作表单与当前业务动作不匹配，请刷新后重试");
      }
      requestKeyRef.current = crypto.randomUUID();
      setForm(nextForm);
      setValues({});
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "暂时无法读取外部操作表单",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setError(null);
    try {
      const inputs: Record<string, unknown> = {};
      for (const field of form.fields) {
        const raw = values[field.fieldKey] ?? "";
        if (!raw && !field.required) continue;
        if (!raw) throw new Error(`${field.label}不能为空`);
        inputs[field.fieldKey] = valueForField(field, raw);
      }
      setBusy(true);
      await client.requestMcpInvocation(
        form.links.request,
        requestKeyRef.current,
        inputs,
      );
      onSubmitted();
      onCloseRef.current();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "外部操作没有发起，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
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
        aria-labelledby="mcp-request-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">受控外部操作</span>
            <h2 id="mcp-request-title">
              {form?.title ?? catalog?.serviceName ?? "选择业务动作"}
            </h2>
            <p>
              {form?.description ?? catalog?.summary ?? "正在读取可用业务动作…"}
            </p>
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

        {form ? (
          <form onSubmit={submit}>
            <div className="mcp-impact-summary">
              <strong>{form.impact}</strong>
              <span>{form.confirmation}</span>
            </div>
            {form.fields.map((field) => (
              <BusinessField
                key={field.fieldKey}
                field={field}
                value={values[field.fieldKey] ?? ""}
                busy={busy}
                onChange={(value) =>
                  setValues((current) => ({
                    ...current,
                    [field.fieldKey]: value,
                  }))
                }
              />
            ))}
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
                onClick={() => setForm(null)}
              >
                返回动作列表
              </button>
              <button className="button primary" type="submit" disabled={busy}>
                {busy ? "正在发起…" : "确认发起"}
              </button>
            </div>
          </form>
        ) : catalog ? (
          <div className="mcp-tool-list">
            {catalog.tools.map((tool) => (
              <button
                key={tool.links.form}
                type="button"
                disabled={busy}
                onClick={() => void chooseTool(tool)}
              >
                <strong>{tool.title}</strong>
                <span>{tool.description}</span>
                <small>
                  {tool.impact} · {tool.confirmation}
                </small>
              </button>
            ))}
          </div>
        ) : busy ? (
          <div className="loading-state" role="status">
            正在读取业务动作…
          </div>
        ) : null}
        {error && !form ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
