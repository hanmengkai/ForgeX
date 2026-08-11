import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ForgeXClient, PlatformAccountItem, PlatformRole } from "./api.js";
import { PlusIcon, UserIcon } from "./icons.js";

const roleOptions: Array<{ value: PlatformRole; label: string }> = [
  { value: "administrator", label: "超级管理员" },
  { value: "product_owner", label: "产品负责人" },
  { value: "requirement_analyst", label: "需求分析师" },
  { value: "developer", label: "研发成员" },
];

const roleLabels = new Map(roleOptions.map((role) => [role.value, role.label]));

interface AccountFormState {
  username: string;
  actorName: string;
  roles: PlatformRole[];
  enabled: boolean;
  password: string;
}

const emptyForm = (): AccountFormState => ({
  username: "",
  actorName: "",
  roles: ["developer"],
  enabled: true,
  password: "",
});

export function AccountManagement({ client }: { client: ForgeXClient }) {
  const [accounts, setAccounts] = useState<PlatformAccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlatformAccountItem | "new" | null>(
    null,
  );
  const [form, setForm] = useState<AccountFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listAccounts();
      if (generation === generationRef.current) setAccounts(result);
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(
          caught instanceof Error ? caught.message : "暂时无法读取账号列表",
        );
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const enabledCount = useMemo(
    () => accounts.filter((account) => account.enabled).length,
    [accounts],
  );

  const openCreate = () => {
    setForm(emptyForm());
    setEditing("new");
    setError(null);
  };

  const openEdit = (account: PlatformAccountItem) => {
    setForm({
      username: account.username,
      actorName: account.actorName,
      roles: [...account.roles],
      enabled: account.enabled,
      password: "",
    });
    setEditing(account);
    setError(null);
  };

  const toggleRole = (role: PlatformRole) => {
    setForm((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role],
    }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !editing) return;
    if (form.roles.length === 0) {
      setError("请至少选择一个角色");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing === "new") {
        await client.createAccount({
          username: form.username.trim().toLowerCase(),
          actorName: form.actorName.trim(),
          roles: form.roles,
          password: form.password,
        });
      } else {
        await client.updateAccount(editing.links.self, editing.revision, {
          actorName: form.actorName.trim(),
          roles: form.roles,
          enabled: form.enabled,
          ...(form.password ? { password: form.password } : {}),
        });
      }
      setForm(emptyForm());
      setEditing(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号保存没有完成");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (account: PlatformAccountItem) => {
    if (!window.confirm(`确认删除账号 ${account.username}？`)) return;
    setError(null);
    try {
      await client.deleteAccount(account.links.self, account.revision);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号删除没有完成");
    }
  };

  return (
    <div className="account-center">
      <header className="topbar account-topbar">
        <div>
          <span className="eyebrow">ACCESS CONTROL</span>
          <h1>账号管理</h1>
          <p>集中管理平台登录账号、显示名称、角色和启用状态。</p>
        </div>
        <button className="button primary" type="button" onClick={openCreate}>
          <PlusIcon />
          新建账号
        </button>
      </header>

      <section className="account-summary" aria-label="账号概况">
        <div>
          <span>账号总数</span>
          <strong>{accounts.length}</strong>
        </div>
        <div>
          <span>正常使用</span>
          <strong>{enabledCount}</strong>
        </div>
        <div>
          <span>已停用</span>
          <strong>{accounts.length - enabledCount}</strong>
        </div>
      </section>

      {error ? (
        <div className="page-error" role="alert">
          {error}
        </div>
      ) : null}

      {editing ? (
        <section className="content-section account-editor">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                {editing === "new" ? "CREATE" : "UPDATE"}
              </span>
              <h2>
                {editing === "new"
                  ? "创建平台账号"
                  : `编辑 ${editing.username}`}
              </h2>
            </div>
            <button
              className="text-action"
              type="button"
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
          <form onSubmit={(event) => void save(event)}>
            <label className="field" htmlFor="managed-username">
              登录账号
              <input
                id="managed-username"
                value={form.username}
                disabled={editing !== "new" || saving}
                minLength={3}
                maxLength={64}
                pattern="[a-z0-9][a-z0-9._-]*[a-z0-9]"
                required
                placeholder="例如：developer.one"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    username: event.target.value,
                  }))
                }
              />
            </label>
            <label className="field" htmlFor="managed-name">
              显示名称
              <input
                id="managed-name"
                value={form.actorName}
                disabled={saving}
                minLength={2}
                maxLength={100}
                required
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    actorName: event.target.value,
                  }))
                }
              />
            </label>
            <label className="field" htmlFor="managed-password">
              {editing === "new" ? "初始密码" : "重置密码（可选）"}
              <input
                id="managed-password"
                type="password"
                value={form.password}
                disabled={saving}
                minLength={12}
                maxLength={128}
                required={editing === "new"}
                autoComplete="new-password"
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
            </label>
            <fieldset className="role-selector">
              <legend>账号角色</legend>
              {roleOptions.map((role) => (
                <label key={role.value}>
                  <input
                    type="checkbox"
                    checked={form.roles.includes(role.value)}
                    disabled={saving}
                    onChange={() => toggleRole(role.value)}
                  />
                  {role.label}
                </label>
              ))}
            </fieldset>
            {editing !== "new" ? (
              <label className="account-enabled-toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  disabled={saving}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                />
                允许该账号登录
              </label>
            ) : null}
            <div className="dialog-actions">
              <button
                className="button primary"
                type="submit"
                disabled={saving}
              >
                {saving ? "正在保存…" : "保存账号"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="content-section account-list-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">DIRECTORY</span>
            <h2>平台账号</h2>
          </div>
          <span className="filter-button">共 {accounts.length} 个</span>
        </div>
        {loading ? (
          <div className="loading-state" role="status">
            正在读取账号…
          </div>
        ) : null}
        {!loading && accounts.length === 0 ? (
          <div className="empty-state compact">
            <h3>还没有平台账号</h3>
            <p>创建第一个账号后即可分配角色。</p>
          </div>
        ) : (
          <div className="account-table" role="list">
            {accounts.map((account) => (
              <article
                className="account-row"
                role="listitem"
                key={account.links.self}
              >
                <span className="account-avatar">
                  <UserIcon />
                </span>
                <div className="account-identity">
                  <strong>{account.actorName}</strong>
                  <span>{account.username}</span>
                </div>
                <div className="account-roles">
                  {account.roles.map((role) => (
                    <span key={role}>{roleLabels.get(role)}</span>
                  ))}
                </div>
                <span
                  className={`status-pill ${account.enabled ? "success" : "neutral"}`}
                >
                  {account.enabled ? "正常" : "已停用"}
                </span>
                <div className="account-actions">
                  <button
                    type="button"
                    aria-label={`编辑 ${account.username}`}
                    onClick={() => openEdit(account)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    aria-label={`删除 ${account.username}`}
                    onClick={() => void remove(account)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
