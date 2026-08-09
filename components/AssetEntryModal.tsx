"use client";

import { X } from "@phosphor-icons/react";
import type { CurrencyCode } from "@/lib/types";

export type AssetDraft = {
  name: string;
  category: string;
  purchaseValue: string;
  purchaseCurrency: CurrencyCode;
  purchaseDate: string;
  currentValue: string;
  currentCurrency: CurrencyCode;
  sellPrice: string;
  usageDays: string;
  status: "active" | "unused" | "sold";
  note: string;
};

const categories = ["手机", "电脑", "相机", "衣物", "家具", "健身器材", "收藏品", "黄金", "软件", "课程", "会员", "自定义"];
const currencies: CurrencyCode[] = ["MYR", "SGD", "USD"];

export default function AssetEntryModal({ draft, setDraft, onClose, onSave, editing }: { draft: AssetDraft; setDraft: React.Dispatch<React.SetStateAction<AssetDraft>>; onClose: () => void; onSave: () => void; editing: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="modal asset-modal" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ASSET</div><h2 id="asset-modal-title">{editing ? "编辑物品资产" : "新增物品资产"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><div className="form-stack"><label>资产名称<input autoFocus placeholder="例如：iPhone 15 Pro" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label><div className="form-grid"><label>分类<select value={categories.includes(draft.category) ? draft.category : "自定义"} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value === "自定义" ? "" : event.target.value }))}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>状态<select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as AssetDraft["status"] }))}><option value="active">使用中</option><option value="unused">闲置</option><option value="sold">已出售</option></select></label></div>{(!categories.includes(draft.category) || draft.category === "") && <label>自定义分类<input placeholder="例如：乐器" value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} /></label>}<div className="form-grid"><label>买入价格<input type="number" min="0" step="0.01" value={draft.purchaseValue} onChange={(event) => setDraft((current) => ({ ...current, purchaseValue: event.target.value }))} /></label><label>买入货币<select value={draft.purchaseCurrency} onChange={(event) => setDraft((current) => ({ ...current, purchaseCurrency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><div className="form-grid"><label>买入日期<input type="date" value={draft.purchaseDate} onChange={(event) => setDraft((current) => ({ ...current, purchaseDate: event.target.value }))} /></label><label>使用天数<input type="number" min="0" step="1" value={draft.usageDays} onChange={(event) => setDraft((current) => ({ ...current, usageDays: event.target.value }))} /></label></div><div className="form-grid"><label>当前价值<input type="number" min="0" step="0.01" value={draft.currentValue} onChange={(event) => setDraft((current) => ({ ...current, currentValue: event.target.value }))} /></label><label>当前货币<select value={draft.currentCurrency} onChange={(event) => setDraft((current) => ({ ...current, currentCurrency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>卖出价格（可选）<input type="number" min="0" step="0.01" placeholder="已出售时填写" value={draft.sellPrice} onChange={(event) => setDraft((current) => ({ ...current, sellPrice: event.target.value }))} /></label><label>备注（可选）<input placeholder="例如：含配件、保修到期日" value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} /></label><p className="form-help">日均成本 =（买入价格 − 当前价值或卖出价格）÷ 使用天数。历史买入货币和当前估值货币会分别保留。</p><button className="primary-button full" onClick={onSave}>{editing ? "保存资产变更" : "保存物品资产"}</button></div></div></div>;
}
