"use client";

import { useState, type FormEvent } from "react";
import {
  ArrowsClockwise,
  CloudArrowUp,
  CloudSlash,
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

        <p className="cloud-note">每个账号只看得到自己的资料，朋友之间互不相通。登录后本机已有资料会自动上传。</p>
      </section>
    </main>
  );
}
