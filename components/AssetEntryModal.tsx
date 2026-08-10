"use client";

import { useMemo } from "react";
import { X } from "@phosphor-icons/react";
import { getAssetCostPerUse, getAssetDailyCost, getAssetUsageDays, getLocalDate } from "@/lib/finance";
import type { CurrencyCode } from "@/lib/types";

export type AssetDraft = {
  name: string;
  category: string;
  purchaseValue: string;
  purchaseCurrency: CurrencyCode;
  purchaseDate: string;
  usageStartMode: "purchaseDate" | "customDate";
  usageStartDate: string;
  currentValue: string;
  currentCurrency: CurrencyCode;
  sellPrice: string;
  saleDate: string;
  usageDays: string;
  useCount: string;
  status: "active" | "unused" | "sold";
  note: string;
};

const categories = ["手机", "电脑", "相机", "衣物", "家具", "健身器材", "收藏品", "黄金", "软件", "课程", "会员", "自定义"];
const currencies: CurrencyCode[] = ["MYR", "SGD", "USD"];

export default function AssetEntryModal({ draft, setDraft, onClose, onSave, editing }: { draft: AssetDraft; setDraft: React.Dispatch<React.SetStateAction<AssetDraft>>; onClose: () => void; onSave: () => void; editing: boolean }) {
  const today = getLocalDate();
  const calculation = useMemo(() => {
    const usageStartDate = draft.usageStartMode === "customDate" ? draft.usageStartDate : draft.purchaseDate;
    const previewAsset = {
      purchaseValue: Number(draft.purchaseValue) || 0,
      currentValue: Number(draft.currentValue) || 0,
      sellPrice: draft.sellPrice.trim() === "" ? undefined : Number(draft.sellPrice),
      purchaseDate: draft.purchaseDate,
      usageStartMode: draft.usageStartMode,
      usageStartDate,
      saleDate: draft.saleDate || undefined,
      status: draft.status,
      useCount: Number(draft.useCount) || 0,
      usageDays: Number(draft.usageDays) || 0,
    } as const;
    const dateError = !usageStartDate
      ? "请先选择使用起算日期"
      : usageStartDate > today
        ? "使用起算日期晚于今天，使用天数将显示为 0"
        : draft.status === "sold" && draft.saleDate && usageStartDate > draft.saleDate
          ? "使用起算日期晚于出售日期，无法计算使用天数"
          : "";
    const usageDays = getAssetUsageDays(previewAsset, today);
    return {
      usageStartDate,
      usageDays,
      dailyCost: dateError ? null : getAssetDailyCost(previewAsset, today),
      costPerUse: dateError ? null : getAssetCostPerUse(previewAsset, today),
      dateError,
    };
  }, [draft, today]);

  const update = (field: keyof AssetDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }));

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="modal asset-modal" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ASSET</div><h2 id="asset-modal-title">{editing ? "编辑物品资产" : "新增物品资产"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><div className="form-stack asset-form-scroll">
    <label>资产名称<input autoFocus placeholder="例如：iPhone 15 Pro" value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
    <div className="form-grid"><label>分类<select value={categories.includes(draft.category) ? draft.category : "自定义"} onChange={(event) => update("category", event.target.value === "自定义" ? "" : event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>状态<select value={draft.status} onChange={(event) => update("status", event.target.value)}><option value="active">使用中</option><option value="unused">闲置</option><option value="sold">已出售</option></select></label></div>
    {(!categories.includes(draft.category) || draft.category === "") && <label>自定义分类<input placeholder="例如：乐器" value={draft.category} onChange={(event) => update("category", event.target.value)} /></label>}
    <div className="form-grid"><label>买入价格<input type="number" min="0" step="0.01" value={draft.purchaseValue} onChange={(event) => update("purchaseValue", event.target.value)} /></label><label>买入货币<select value={draft.purchaseCurrency} onChange={(event) => update("purchaseCurrency", event.target.value)}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div>
    <div className="form-grid"><label>买入日期<input type="date" value={draft.purchaseDate} onChange={(event) => update("purchaseDate", event.target.value)} /></label><label>使用天数起算方式<select value={draft.usageStartMode} onChange={(event) => update("usageStartMode", event.target.value)}><option value="purchaseDate">从买入日期开始计算</option><option value="customDate">从自定义日期开始计算</option></select></label></div>
    {draft.usageStartMode === "customDate" && <label>使用开始日期<input type="date" value={draft.usageStartDate} onChange={(event) => update("usageStartDate", event.target.value)} aria-describedby="usage-date-help" /><span id="usage-date-help" className="form-help-inline">买入日期：{draft.purchaseDate || "未设置"}</span></label>}
    <div className="form-grid"><label>当前价值<input type="number" min="0" step="0.01" value={draft.currentValue} onChange={(event) => update("currentValue", event.target.value)} /></label><label>当前货币<select value={draft.currentCurrency} onChange={(event) => update("currentCurrency", event.target.value)}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div>
    {draft.status === "sold" && <div className="form-grid"><label>出售价格<input type="number" min="0" step="0.01" placeholder="已出售时填写" value={draft.sellPrice} onChange={(event) => update("sellPrice", event.target.value)} /></label><label>出售日期<input type="date" value={draft.saleDate} onChange={(event) => update("saleDate", event.target.value)} /></label></div>}
    {draft.status !== "sold" && <label>出售价格（可选）<input type="number" min="0" step="0.01" placeholder="标记为已出售时填写" value={draft.sellPrice} onChange={(event) => update("sellPrice", event.target.value)} /></label>}
    <label>备注（可选）<input placeholder="例如：含配件、保修到期日" value={draft.note} onChange={(event) => update("note", event.target.value)} /></label>
    <section className="asset-calculation" aria-live="polite"><div className="asset-calculation-heading"><div><div className="panel-kicker">自动计算</div><strong>使用价值</strong></div><span>只读</span></div><div className="asset-calculation-grid"><div><span>使用天数起算</span><b>{draft.usageStartMode === "purchaseDate" ? "从买入日期开始计算" : "从自定义日期开始计算"}</b></div><div><span>使用起算日期</span><b>{calculation.usageStartDate || "等待日期"}</b></div><div><span>当前使用天数</span><input className="readonly-field" readOnly value={calculation.usageDays === 0 ? "0 天" : `${calculation.usageDays} 天`} aria-label="当前使用天数，只读自动计算" /></div><div><span>当前日均成本</span><b>{calculation.dailyCost === null ? "尚未计算" : `${draft.currentCurrency} ${calculation.dailyCost.toFixed(2)}`}</b></div><div><span>累计使用次数（可选）</span><input type="number" min="0" step="1" value={draft.useCount} onChange={(event) => update("useCount", event.target.value)} /></div><div><span>单次使用成本</span><b>{calculation.costPerUse === null ? "尚未设置使用次数" : `${draft.currentCurrency} ${calculation.costPerUse.toFixed(2)}`}</b></div></div>{calculation.dateError && <p className="asset-date-error" role="alert">{calculation.dateError}</p>}<p className="form-help">当前持有成本 = 买入价格 - 当前价值。已出售资产改用卖出价格，并在出售日期停止计算。</p></section>
    <button className="primary-button full asset-save-button" onClick={onSave}>{editing ? "保存资产变更" : "保存物品资产"}</button>
  </div></div></div>;
}
