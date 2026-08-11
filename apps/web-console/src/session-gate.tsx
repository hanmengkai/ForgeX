import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  ForgeXHttpError,
  type ForgeXClient,
  type SessionProfile,
} from "./api.js";
import { SparkIcon } from "./icons.js";
import { RequirementWorkbench } from "./requirement-workbench.js";
import { ThemeToggle } from "./theme.js";

export function SessionGate({
  client,
  projectName,
}: {
  client: ForgeXClient;
  projectName: string;
}) {
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [checking, setChecking] = useState(true);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const generationRef = useRef(0);
  const submittingRef = useRef(false);

  const checkSession = async () => {
    const generation = ++generationRef.current;
    setChecking(true);
    setServiceError(null);
    try {
      const current = await client.getSession();
      if (generation === generationRef.current) setProfile(current);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setProfile(null);
      if (!(caught instanceof ForgeXHttpError) || caught.statusCode !== 401) {
        setServiceError(
          caught instanceof Error
            ? caught.message
            : "暂时无法连接 ForgeX，请稍后重试",
        );
      }
    } finally {
      if (generation === generationRef.current) setChecking(false);
    }
  };

  useEffect(() => {
    void checkSession();
    return () => {
      generationRef.current += 1;
    };
    // client 的生命周期与页面一致，只在挂载时恢复一次同源会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setLoginError(null);
    try {
      const current = await client.startSession({ username, password });
      setPassword("");
      setProfile(current);
    } catch (caught) {
      setLoginError(
        caught instanceof Error ? caught.message : "登录没有完成，请重试",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const logout = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await client.endSession();
      setProfile(null);
      setLoginError(null);
    } catch (caught) {
      setServiceError(
        caught instanceof Error ? caught.message : "退出没有完成，请重试",
      );
    } finally {
      setSigningOut(false);
    }
  };

  if (checking) {
    return (
      <main className="session-page" aria-busy="true">
        <ThemeToggle />
        <div className="session-card" role="status">
          正在确认登录状态…
        </div>
      </main>
    );
  }

  if (profile) {
    return (
      <RequirementWorkbench
        client={client}
        projectName={projectName}
        actorName={profile.actorName}
        actorUsername={profile.username}
        roles={profile.roles}
        onSignOut={logout}
        signingOut={signingOut}
      />
    );
  }

  return (
    <main className="session-page">
      <ThemeToggle />
      <section className="session-card" aria-labelledby="session-title">
        <span className="session-brand-mark" aria-hidden="true">
          <SparkIcon />
        </span>
        <span className="eyebrow">ForgeX CONTROL PLANE</span>
        <h1 id="session-title">登录交付控制台</h1>
        <p>
          使用平台管理员分配的账号登录。密码只发送到同源控制面，不会写入浏览器存储。
        </p>
        {serviceError ? (
          <div className="page-error" role="alert">
            {serviceError}
            <button type="button" onClick={() => void checkSession()}>
              重新连接
            </button>
          </div>
        ) : null}
        <form onSubmit={(event) => void login(event)}>
          <label htmlFor="account-username">账号</label>
          <input
            id="account-username"
            type="text"
            value={username}
            autoComplete="username"
            minLength={3}
            maxLength={64}
            required
            disabled={submitting}
            placeholder="例如：product.owner"
            onChange={(event) => setUsername(event.target.value)}
          />
          <label htmlFor="account-password">密码</label>
          <input
            id="account-password"
            type="password"
            value={password}
            autoComplete="current-password"
            minLength={12}
            maxLength={128}
            required
            disabled={submitting}
            onChange={(event) => setPassword(event.target.value)}
          />
          {loginError ? (
            <p className="detail-error" role="alert">
              {loginError}
            </p>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "正在验证…" : "登录"}
          </button>
        </form>
        <small>忘记密码或账号被停用时，请联系 ForgeX 超级管理员。</small>
      </section>
    </main>
  );
}
