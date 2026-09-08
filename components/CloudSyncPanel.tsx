"use client";

import { useState, type FormEvent } from "react";
import {
  ArrowsClockwise,
  CheckCircle,
  CloudArrowUp,
  CloudSlash,
  Envelope,
  SignIn,
  SignOut,
  UserCirclePlus,
  WarningCircle,
} from "@phosphor-icons/react";
import type { CloudSyncController } from "@/lib/use-cloud-sync";

export default function CloudSyncPanel({ cloud }: { cloud: CloudSyncController }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryDone, setRecoveryDone] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    try {
      if (mode === "signin") await cloud.signIn(email.trim(), password);
      else await cloud.signUp(email.trim(), password);
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await cloud.resetPassword(email.trim());
      setResetSent(true);
    } catch (cause) {
      setResetError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResetBusy(false);
    }
  };

  const submitRecovery = async (event: FormEvent) => {
    event.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      setRecoveryError("新密码至少 6 位。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setRecoveryError("两次输入的密码不一致。");
      return;
    }
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      await cloud.completePasswordReset(newPassword);
      setRecoveryDone(true);
    } catch (cause) {
      setRecoveryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const inFlight = busy || cloud.status === "syncing";

  // 未配置 Supabase
  if (cloud.status === "unconfigured") {
    return (
      <main className="main-content module-page cloud-sync-page">
        <header className="page-header module-header">
          <div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>云端同步</h1></div>
        </header>
        <section className="panel">
          <div className="panel-title-row">
            <div><div className="panel-kicker">CLOUD SYNC</div><h2>尚未配置云端</h2></div>
            <CloudSlash size={20} />
          </div>
          <p className="cloud-intro">需要在 Supabase 建好项目并填入 Project URL 与 anon key 后，才能登录并跨设备同步。</p>
        </section>
      </main>
    );
  }

  // 重置密码（从邮件链接回来，设置新密码）
  if (cloud.recovering) {
    return (
      <main className="main-content module-page cloud-sync-page">
        <header className="page-header module-header">
          <div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>重置密码</h1></div>
        </header>
        <section className="panel">
          <div className="panel-title-row">
            <div><div className="panel-kicker">CLOUD SYNC</div><h2>设置新密码</h2></div>
            <CloudArrowUp size={20} />
          </div>

          {recoveryDone ? (
            <div className="reset-sent" role="status">
              <CheckCircle size={18} />
              <div><strong>密码已重置</strong><span>请用新密码回到「设置 → 云端同步」登录。</span></div>
            </div>
          ) : (
            <form className="form-stack cloud-form" onSubmit={submitRecovery}>
              <p className="cloud-intro" style={{ margin: 0 }}>输入你的新密码（至少 6 位），提交后即可用新密码登录。</p>
              {recoveryError && (
                <div className="sync-error" role="alert">
                  <WarningCircle size={18} />
                  <div><strong>需要处理</strong><span>{recoveryError}</span></div>
                </div>
              )}
              <label>
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </label>
              <label>
                确认新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </label>
              <button type="submit" className="primary-button full" disabled={recoveryBusy}>
                <CheckCircle size={16} /> {recoveryBusy ? "提交中…" : "设置新密码"}
              </button>
            </form>
          )}
        </section>
      </main>
    );
  }

  // 已登录
  if (cloud.user) {
    return (
      <main className="main-content module-page cloud-sync-page">
        <header className="page-header module-header">
          <div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>云端同步</h1></div>
        </header>
        <section className="panel">
          <div className="panel-title-row">
            <div><div className="panel-kicker">CLOUD SYNC</div><h2>云端同步</h2></div>
            <span className={"status-chip" + (cloud.status === "ready" ? " safe" : cloud.status === "error" ? " attention" : "")}>
              {cloud.status === "syncing" ? "同步中…" : cloud.status === "error" ? "需处理" : "已连接"}
            </span>
          </div>

          <div className="cloud-account">
            <span className="cloud-dot" aria-hidden="true" />
            <div>
              <strong>{cloud.user.email ?? cloud.user.id}</strong>
              <span>
                {cloud.status === "syncing" ? "正在同步…"
                  : cloud.status === "error" ? "同步出错"
                  : cloud.lastSyncedAt ? `已是最新 · ${cloud.lastSyncedAt}` : "已连接"}
              </span>
            </div>
          </div>

          {cloud.error && (
            <div className="sync-error" role="alert">
              <WarningCircle size={18} />
              <div><strong>需要处理</strong><span>{cloud.error}</span></div>
            </div>
          )}

          <p className="cloud-note">本机改动会自动上传；其他设备的改动会自动拉回并合并。每台设备用同一账号登录，数据即保持一致。</p>

          <div className="cloud-actions">
            <button type="button" className="primary-button" onClick={() => void cloud.syncNow()} disabled={inFlight}>
              <ArrowsClockwise size={16} /> 立即同步
            </button>
            <button type="button" className="secondary-button" onClick={() => void cloud.signOut()}>
              <SignOut size={16} /> 登出
            </button>
          </div>
        </section>
      </main>
    );
  }

  // 未登录：登录 / 注册
  return (
    <main className="main-content module-page cloud-sync-page">
      <header className="page-header module-header">
        <div><div className="breadcrumb">WEALTH ATLAS / SETTINGS</div><h1>云端同步</h1></div>
      </header>
      <section className="panel">
        <div className="panel-title-row">
          <div><div className="panel-kicker">CLOUD SYNC</div><h2>登录并同步</h2></div>
          <CloudArrowUp size={20} />
        </div>
        <p className="cloud-intro">登录后，手机和电脑的资料会自动同步、保持一致。</p>

        {cloud.error && (
          <div className="sync-error" role="alert">
            <WarningCircle size={18} />
            <div><strong>需要处理</strong><span>{cloud.error}</span></div>
          </div>
        )}

        {resetMode ? (
          <>
            {resetSent ? (
              <div className="reset-sent" role="status">
                <CheckCircle size={18} />
                <div><strong>重置邮件已发送</strong><span>请到邮箱查收邮件，点里面的链接重设密码，然后回到这里用新密码登录。</span></div>
              </div>
            ) : (
              <form className="form-stack cloud-form" onSubmit={submitReset}>
                <p className="cloud-intro" style={{ margin: 0 }}>输入注册时的邮箱，我们会发一封重置邮件给你。</p>
                {resetError && (
                  <div className="sync-error" role="alert">
                    <WarningCircle size={18} />
                    <div><strong>需要处理</strong><span>{resetError}</span></div>
                  </div>
                )}
                <label>
                  邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" className="primary-button full" disabled={resetBusy}>
                  <Envelope size={16} /> {resetBusy ? "发送中…" : "发送重置邮件"}
                </button>
              </form>
            )}
            <button type="button" className="cloud-back-link" onClick={() => { setResetMode(false); setResetSent(false); setResetError(null); }}>
              ← 返回登录
            </button>
          </>
        ) : (
          <>
            <form className="form-stack cloud-form" onSubmit={submit}>
              <div className="segmented" role="tablist" aria-label="登录或注册">
                <button type="button" className={mode === "signin" ? "selected" : ""} onClick={() => setMode("signin")}>登录</button>
                <button type="button" className={mode === "signup" ? "selected" : ""} onClick={() => setMode("signup")}>注册新账号</button>
              </div>
              <label>
                邮箱
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={6}
                />
              </label>
              <button type="submit" className="primary-button full" disabled={inFlight}>
                {mode === "signin" ? <SignIn size={16} /> : <UserCirclePlus size={16} />}
                {inFlight ? "处理中…" : mode === "signin" ? "登录" : "注册并上传"}
              </button>
            </form>
            <button type="button" className="cloud-back-link" onClick={() => { setResetMode(true); setResetError(null); }}>
              忘记密码？
            </button>
          </>
        )}

        <p className="cloud-note">每个账号只看得到自己的资料，朋友之间互不相通。登录后本机已有资料会自动上传。</p>
      </section>
    </main>
  );
}
