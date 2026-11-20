"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assertActiveDataProfile, getDataProfile } from "@/lib/data-profile";
import { getAccountRevision, isAccountVerified, subscribeAccountBoundary } from "@/lib/account-boundary";
import type { createLocalInvestmentSpace } from "@/desktop/investment/local-space.cjs";
import styles from "./InvestmentSpaceChooser.module.css";

type Space = ReturnType<typeof createLocalInvestmentSpace>;
export default function InvestmentSpaceChooser({space,mode,onChoose,onLogin}:{space:Space;mode:"vault"|"account";onChoose:(mode:"vault"|"account")=>void;onLogin:()=>void}) {
  const revision=useSyncExternalStore(subscribeAccountBoundary,getAccountRevision,()=>0);
  const profile=getDataProfile(), eligible=profile.kind==="cloud"&&!!profile.ownerId;
  const [status,setStatus]=useState<{enabled:boolean;selected:boolean}|null>(null);
  const [error,setError]=useState("");const [loading,setLoading]=useState(eligible);
  const [confirm,setConfirm]=useState(false),[ack,setAck]=useState(false),[busy,setBusy]=useState(false);
  const inFlight=useRef(false),mounted=useRef(true),dialog=useRef<HTMLDialogElement>(null),origin=useRef<HTMLElement|null>(null);
  const load=useCallback(async()=>{
    if(!eligible){onChoose("vault");return;}setLoading(true);
    try{const value=await space.status();assertActiveDataProfile(profile);if(!mounted.current)return;setStatus(value);setError("");onChoose(value.enabled&&value.selected?"account":"vault");}
    catch{if(mounted.current)setError("本机投资空间读取失败，原资料未被覆盖。请重新读取，不要清空资料。");}
    finally{if(mounted.current)setLoading(false);}
  },[eligible,space,profile,onChoose]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;};},[load]);
  useEffect(()=>{if(confirm&&!dialog.current?.open){dialog.current?.showModal();dialog.current?.querySelector<HTMLElement>("h2")?.focus();}if(!confirm&&dialog.current?.open)dialog.current.close();},[confirm]);
  const close=()=>{if(inFlight.current)return;setConfirm(false);requestAnimationFrame(()=>origin.current?.isConnected&&origin.current.focus());};
  async function choose(next:"vault"|"account",trigger:HTMLElement){
    if(inFlight.current||loading)return;
    if(next==="account"&&!eligible){onLogin();return;}
    if(next==="account"&&!status?.enabled){
      if(error||loading)return;
      if(!isAccountVerified()){setError("请先联网验证现有账号，再首次启用本机投资空间。已保存资料不会被清空。");return;}
      origin.current=trigger;setAck(false);setConfirm(true);return;
    }
    inFlight.current=true;setBusy(true);
    try{if(status?.enabled)await space.select(next==="account");assertActiveDataProfile(profile);if(mounted.current){setError("");onChoose(next);}}
    catch{if(mounted.current)setError("保存位置未能切换，原空间和输入仍保留。请重试。");}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }
  async function enable(){
    if(inFlight.current||!ack)return;
    if(!isAccountVerified()){setError("账号尚未验证，未启用投资空间。");return;}
    inFlight.current=true;setBusy(true);
    try{assertActiveDataProfile(profile);await space.enable();await space.select(true);assertActiveDataProfile(profile);if(!mounted.current)return;setStatus({enabled:true,selected:true});setError("");onChoose("account");setConfirm(false);requestAnimationFrame(()=>origin.current?.isConnected&&origin.current.focus());}
    catch{if(mounted.current)setError("启用未能完成，原资料未被覆盖。请重新读取后重试。");}
    finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  }
  const disabled=busy||loading||!!error;
  const action=!eligible?"前往设置登录":loading?"正在读取…":mode==="account"?"返回本机 Vault":status?.enabled?"打开账号投资空间":"启用账号投资空间";
  void revision; // Account verification changes update eligibility without changing the auth flow.
  return <>
    <section className={`panel ${styles.chooser}`} aria-labelledby="investment-space-title">
      <header className={styles.heading}><h2 id="investment-space-title">投资资料保存位置</h2><span className="status-chip">{mode==="account"?"仅本机":"本机 Vault"}</span></header>
      <div className={styles.buttons} role="group" aria-label="投资资料工作区">
        <button className="secondary-button" type="button" aria-pressed={mode==="vault"} title="查看原本机 Vault 投资记录" disabled={busy||loading} onClick={e=>void choose("vault",e.currentTarget)}>本机 Vault</button>
        <button className="secondary-button" type="button" aria-pressed={mode==="account"} title="打开当前账号的本机投资空间" disabled={eligible&&disabled} onClick={e=>void choose("account",e.currentTarget)}>账号投资空间</button>
      </div>
      <div className={styles.feedback} role="status"><strong>{error?"需要处理":!eligible?"请先验证现有账号":loading?"正在检查本机空间":status?.enabled?"账号投资空间已启用":"未启用账号投资空间"}</strong><p>{error||"仅本机，不跨设备同步；保留 Vault 旧记录，不自动导入。"}</p></div>
      <div className={`${styles.buttons} ${styles.actions}`}><button className="primary-button" type="button" title={action} disabled={eligible&&disabled} onClick={e=>void choose(mode==="account"?"vault":"account",e.currentTarget)}>{busy?"正在处理…":action}</button>{error&&<button className="secondary-button" type="button" disabled={busy||loading} onClick={()=>void load()}>重新读取</button>}</div>
      <details className={styles.details}><summary>查看保存范围与资料保护说明</summary><p>使用现有登录账号，不需要另行注册。首次启用为空白，不读取或导入原 Vault。各账号分别保存，更换设备不会自动带过去；本空间不纳入原收支云同步及财务快照恢复。原账户、历史交易、收支同步和 Obsidian 流程保持不变。</p></details>
    </section>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="investment-enable-title" aria-describedby="investment-enable-description" onCancel={e=>{e.preventDefault();close();}} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();if(e.target===e.currentTarget&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))close();}}>
      <div className={styles.frame}><header className={styles.modalHeading}><h2 id="investment-enable-title" tabIndex={-1}>启用当前账号的投资空间？</h2><button type="button" className="secondary-button" aria-label="关闭启用确认" disabled={busy} onClick={close}>关闭</button></header>
        <div className={styles.body}><p id="investment-enable-description">使用你现有的 Wealth Atlas 登录账号，在这台设备建立独立投资空间。不需要另行注册账号。</p><ul><li>仅保存在本机，不做跨设备投资同步。</li><li>首次启用为空白，不读取或导入原 Vault 记录。</li><li>不同账号分别保存，切换账号不混用资料。</li><li>不改变账户余额、历史交易或现有收支同步。</li><li>不自动写入、删除或覆盖 Obsidian 文件。</li></ul><label className={styles.ack}><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/><span>我了解：这个投资空间仅限本机，不会自动同步到 Mac 或其他设备。</span></label>{error&&<p role="alert">{error}</p>}</div>
        <footer className={styles.footer}><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button type="button" className="primary-button" disabled={busy||!ack} onClick={()=>void enable()}>{busy?"正在启用…":"确认启用投资空间"}</button></footer>
      </div>
    </dialog>
  </>;
}
