"use client";

import { useEffect,useMemo,useRef,useState,type Dispatch,type ElementType,type SetStateAction } from "react";
import {
  ArrowsLeftRight,
  ArrowRight,
  Bank,
  Bell,
  Briefcase,
  CalendarDots,
  ChartLineUp,
  ChartPieSlice,
  Check,
  Coins,
  CreditCard,
  FileXls,
  FileText,
  GearSix,
  House,
  ListChecks,
  MagnifyingGlass,
  Money,
  Plus,
  PencilSimple,
  Receipt,
  Scales,
  ShieldCheck,
  Sparkle,
  Target,
  Trash,
  Wallet,
  X,
} from "@phosphor-icons/react";
import { exportExcel } from "@/lib/exporters";
import ObsidianWorkbench from "@/components/ObsidianWorkbench";
import FxCenter from "@/components/FxCenter";
import AssetEntryModal,{ type AssetDraft } from "@/components/AssetEntryModal";
import AdvancedWorkbench from "@/components/AdvancedWorkbench";
import HomeLayoutGrid,{ type HomeLayoutItem } from "@/components/HomeLayoutGrid";
import ProtectedDeleteDialog from "@/components/ProtectedDeleteDialog";
import {
  calculateFreeToSpend,
  convert,
  formatMoney,
  getAccountActivityCount,
  getAccountBalance,
  getBudgetRemaining,
  getBudgetSpent,
  getAnnualPlanTotal,
  getGoalGap,
  getGoalMonthsRemaining,
  getGoalPeriodLabel,
  getGoalProgress,
  getGoalRequiredPerPeriod,
  getGoalRequiredPerMonth,
  getLiquidBalanceInCurrency,
  getMonthTransactions,
  getRate,
  getRateAtDate,
  getRateRecord,
  createFxSnapshot,
  getTransferEffectiveRate,
  getCurrencyExposures,
  getFinanceAlerts,
  getAssetDailyCost,
  getAssetCostPerUse,
  getAssetPurchaseCurrency,
  getAssetCurrentCurrency,
  getAssetRealizedValue,
  getAssetUsageDays,
  getAssetValueChange,
  getLocalDate,
  getUpcomingPlannedPayments,
  getWatchlistMetrics,
  totalExpensesInCurrency,
  totalIncomeInCurrency,
  totalInCurrency,
} from "@/lib/finance";
import { loadWealthData,saveWealthData } from "@/lib/storage";
import { migrateWealthData } from "@/lib/migrations";
import type { Account,AnnualPlan,CurrencyCode,Goal,MonthlyBudget,Transaction,TransactionCategory,Transfer,WealthData } from "@/lib/types";

const today=getLocalDate();
const currentMonth=today.slice(0,7);
const currencies: CurrencyCode[]=["SGD","MYR","USD"];

const initialData: WealthData={
  reportCurrency: "MYR",
  schemaVersion: 10,
  categories: [
    { id: "income:新加坡工资",name: "新加坡工资",kind: "income",color: "#7fc9a3",active: true },
    { id: "income:奖金",name: "奖金",kind: "income",color: "#7fc9a3",active: true },
    { id: "income:其他收入",name: "其他收入",kind: "income",color: "#7fc9a3",active: true },
    { id: "expense:外食",name: "外食",kind: "expense",color: "#d7aa6f",active: true },
    { id: "expense:房租",name: "房租",kind: "expense",color: "#d7aa6f",active: true },
    { id: "expense:保险",name: "保险",kind: "expense",color: "#d7aa6f",active: true },
    { id: "expense:购物",name: "购物",kind: "expense",color: "#d7aa6f",active: true },
    { id: "expense:其他支出",name: "其他支出",kind: "expense",color: "#d7aa6f",active: true },
  ],
  accounts: [
    { id: "sgd-main",name: "新加坡工资账户",type: "bank",currency: "SGD",balance: 0 },
    { id: "myr-main",name: "马来西亚生活账户",type: "bank",currency: "MYR",balance: 0 },
    { id: "usd-invest",name: "USD 投资账户",type: "investment",currency: "USD",balance: 5000 },
  ],
  transactions: [
    { id: "salary",type: "income",accountId: "sgd-main",amount: 8600,currency: "SGD",category: "新加坡工资",date: "2026-08-01" },
    { id: "food-1",type: "expense",accountId: "myr-main",amount: 620,currency: "MYR",category: "外食",merchant: "本月累计",date: today },
    { id: "rent",type: "expense",accountId: "myr-main",amount: 1600,currency: "MYR",category: "房租",date: "2026-08-02" },
    { id: "insurance",type: "expense",accountId: "myr-main",amount: 450,currency: "MYR",category: "保险",date: "2026-08-04" },
  ],
  transfers: [
    { id: "transfer-1",fromAccountId: "sgd-main",toAccountId: "myr-main",fromAmount: 2000,fromCurrency: "SGD",toAmount: 6960,toCurrency: "MYR",rate: 3.48,fee: 5,feeCurrency: "SGD",date: "2026-08-02",inputRate: 3.48,actualRate: 3.48,effectiveRate: 3.4713216957605985,rateDate: "2026-08-02",rateSource: "手动输入",fxSnapshot: { originalAmount: 2000,originalCurrency: "SGD",convertedAmount: 6960,convertedCurrency: "MYR",rateDirection: "SGD/MYR",rate: 3.48,rateDate: "2026-08-02",rateSource: "手动输入",rateId: "sgd-myr-old",fee: 5,feeCurrency: "SGD",effectiveRate: 3.4713216957605985 } },
  ],
  fxRates: [
    { id: "sgd-myr",baseCurrency: "SGD",quoteCurrency: "MYR",rate: 3.48,effectiveDate: today,enteredAt: `${today}T08:00:00.000Z`,source: "手动输入",isDefault: true,active: true,useCount: 4,note: "当前手动输入" },
    { id: "sgd-myr-old",baseCurrency: "SGD",quoteCurrency: "MYR",rate: 3.42,effectiveDate: "2026-07-08",enteredAt: "2026-07-08T08:00:00.000Z",source: "手动输入",isDefault: false,active: true,useCount: 1,note: "历史记录" },
    { id: "usd-sgd",baseCurrency: "USD",quoteCurrency: "SGD",rate: 1.34,effectiveDate: today,enteredAt: `${today}T08:05:00.000Z`,source: "手动输入",isDefault: true,active: true,useCount: 2,note: "当前手动输入" },
    { id: "usd-sgd-old",baseCurrency: "USD",quoteCurrency: "SGD",rate: 1.31,effectiveDate: "2026-07-08",enteredAt: "2026-07-08T08:05:00.000Z",source: "手动输入",isDefault: false,active: true,useCount: 0,note: "历史记录" },
  ],
  budgets: [
    { id: "budget-food",month: currentMonth,category: "外食",limit: 800,currency: "MYR" },
    { id: "budget-shopping",month: currentMonth,category: "购物",limit: 600,currency: "MYR" },
  ],
  goals: [
    { id: "travel",name: "旅行基金",current: 7200,target: 10000,currency: "MYR",percent: 72,due: "2026-12-01",cadence: "monthly",status: "on-track" },
    { id: "house",name: "房屋首期",current: 38000,target: 100000,currency: "MYR",percent: 38,due: "2030-01-01",cadence: "yearly",status: "watch" },
    { id: "study",name: "学习基金",current: 4200,target: 5000,currency: "MYR",percent: 84,due: "2026-10-15",cadence: "custom",status: "on-track" },
  ],
  annualPlans: [
    { id: "plan-travel",year: 2026,month: 12,name: "年底旅行",category: "旅行",amount: 10000,currency: "MYR",status: "funded",goalId: "travel",note: "与旅行基金目标关联" },
    { id: "plan-insurance",year: 2026,month: 11,name: "保险年缴",category: "保险",amount: 5400,currency: "MYR",status: "planned",note: "提前两个月预留" },
    { id: "plan-device",year: 2027,month: 3,name: "设备更新",category: "数码",amount: 3000,currency: "MYR",status: "planned",note: "预留给下一台工作设备" },
  ],
  assets: [
    { id: "macbook",name: "MacBook",category: "电脑",purchaseValue: 6999,purchaseCurrency: "MYR",purchaseDate: "2024-11-07",usageStartMode: "purchaseDate",usageStartDate: "2024-11-07",currentValue: 4800,currentCurrency: "MYR",currency: "MYR",dailyCost: 3.42,usageDays: 642,status: "active" },
    { id: "camera",name: "相机",category: "相机",purchaseValue: 5500,purchaseCurrency: "MYR",purchaseDate: "2025-04-23",usageStartMode: "purchaseDate",usageStartDate: "2025-04-23",currentValue: 4200,currentCurrency: "MYR",currency: "MYR",dailyCost: 2.74,usageDays: 475,status: "active" },
    { id: "gold",name: "黄金",category: "黄金",purchaseValue: 10000,purchaseCurrency: "MYR",purchaseDate: "2025-10-03",usageStartMode: "purchaseDate",usageStartDate: "2025-10-03",currentValue: 11200,currentCurrency: "MYR",currency: "MYR",dailyCost: 0,usageDays: 312,status: "active" },
  ],
  plannedPayments: [
    { id: "insurance-reserve",name: "保险预留",amount: 450,currency: "MYR",due: `${currentMonth}-18`,cadence: "monthly",category: "保险" },
    { id: "sgd-transfer",name: "SGD 转 MYR",amount: 2000,currency: "SGD",due: `${currentMonth}-25`,cadence: "monthly",category: "资金转换" },
  ],
  watchlists: [
    { id: "food",name: "外食",spent: 620,limit: 800,average: 710,forecast: 940,currency: "MYR" },
    { id: "shopping",name: "购物",spent: 340,limit: 600,average: 520,forecast: 480,currency: "MYR" },
  ],
};

type ModalType="transaction"|"transfer"|"fx"|"account"|"budget"|"goal"|"annual-plan"|null;
type NavItem={ label: string; icon: ElementType; key: string; };
type TransactionDraft={ type: "income"|"expense"; accountId: string; amount: string; category: string; categoryId?: string; merchant: string; date: string; note: string; };
type TransferDraft={ fromAccountId: string; toAccountId: string; amount: string; rate: string; fee: string; feeCurrency: CurrencyCode; date: string; };
type AccountDraft={ name: string; type: Account["type"]; currency: CurrencyCode; balance: string; accountGroup?: string; parentAccountId?: string; institution?: string; includeInNetWorth?: boolean; };
type BudgetDraft={ month: string; category: string; categoryId?: string; limit: string; budgetAmount?: string; currency: CurrencyCode; period?: string; };
type GoalDraft={ name: string; current: string; target: string; currency: CurrencyCode; due: string; startDate?: string; endDate?: string; periodAmount?: string; priority?: NonNullable<Goal["priority"]>; isAutomatic?: boolean; cadence: Goal["cadence"]; status: Goal["status"]; };
type AnnualPlanDraft={ year: string; month: string; name: string; category: string; amount: string; currency: CurrencyCode; status: "planned"|"funded"|"complete"; goalId: string; note: string; };
type RecordDetailState={ kind: "transaction"|"transfer"; id: string; }|null;
type DeleteTarget={ kind: "transaction"|"transfer"; record: Transaction|Transfer; }|null;
type EntityDeleteTarget={ kind: "category"|"budget"|"goal"|"asset"|"annual-plan"; id: string; action: "deactivate"|"delete"|"permanent"; }|null;

function emptyAssetDraft(): AssetDraft {
  return { name: "",category: "电脑",purchaseValue: "0",purchaseCurrency: "MYR",purchaseDate: today,usageStartMode: "purchaseDate",usageStartDate: today,currentValue: "0",currentCurrency: "MYR",sellPrice: "",saleDate: today,usageDays: "0",useCount: "0",status: "active",note: "" };
}

const navItems: NavItem[]=[
  { label: "首页",icon: House,key: "home" },
  { label: "账户总览",icon: Wallet,key: "accounts" },
  { label: "收支记录",icon: Receipt,key: "transactions" },
  { label: "预算管理",icon: Scales,key: "budget" },
  { label: "资产管理",icon: Briefcase,key: "assets" },
  { label: "目标与计划",icon: Target,key: "goals" },
  { label: "未来现金流",icon: CalendarDots,key: "cashflow" },
  { label: "Watchlist",icon: MagnifyingGlass,key: "watchlists" },
  { label: "保险管理",icon: ShieldCheck,key: "insurance" },
  { label: "报表中心",icon: ChartLineUp,key: "reports" },
  { label: "理财师提醒",icon: Bell,key: "insights" },
  { label: "汇率中心",icon: Coins,key: "fx" },
  { label: "回收站",icon: Trash,key: "trash" },
];

const accountTypeLabels: Record<Account["type"],string>={ bank: "银行账户",cash: "现金",investment: "投资账户","credit-card": "信用卡" };

function getAccount(data: WealthData,id: string) {
  return data.accounts.find((account) => account.id===id);
}

function getAccountHistoryCount(data: WealthData, accountId: string) {
  return data.transactions.filter((item) => item.accountId === accountId).length
    + data.transfers.filter((item) => item.fromAccountId === accountId || item.toAccountId === accountId).length;
}

function canPermanentlyDeleteAccount(data: WealthData, accountId: string) {
  return getAccountHistoryCount(data, accountId) === 0
    && !data.accounts.some((account) => account.parentAccountId === accountId);
}

function normalizeAsset(asset: WealthData["assets"][number]) {
  const currentCurrency=getAssetCurrentCurrency(asset);
  const purchaseCurrency=getAssetPurchaseCurrency(asset);
  const category=asset.name==="MacBook"? "电脑":asset.name==="相机"? "相机":asset.name==="黄金"? "黄金":asset.category;
  const usageStartMode=asset.usageStartMode??"purchaseDate";
  const usageStartDate=asset.usageStartDate??asset.purchaseDate;
  const normalized={ ...asset,category,purchaseCurrency,purchaseDate: asset.purchaseDate,usageStartMode,usageStartDate,currentCurrency,currency: currentCurrency,sellPrice: asset.sellPrice,saleDate: asset.saleDate,useCount: asset.useCount??0 };
  const calculatedUsageDays=getAssetUsageDays(normalized,today);
  const usageDays=usageStartDate? calculatedUsageDays:Math.max(0,asset.usageDays??0);
  const legacyUsageDays=!asset.usageStartMode||!("usageStartDate" in asset)
    ? asset.usageDays!==undefined&&usageStartDate&&asset.usageDays!==calculatedUsageDays? asset.usageDays:undefined
    :asset.legacyUsageDays;
  return { ...normalized,usageDays,legacyUsageDays,dailyCost: getAssetDailyCost({ ...normalized,usageDays },today),costPerUse: getAssetCostPerUse({ ...normalized,usageDays },today)??undefined };
}

function normalizeAssets(assets: WealthData["assets"]) {
  let migrated=0;
  let recalculated=0;
  const backups: NonNullable<WealthData["assetMigrationBackups"]>=[];
  const normalized=assets.map((asset) => {
    const next=normalizeAsset(asset);
    if(!asset.usageStartMode||!("usageStartDate" in asset)) {
      migrated+=1;
      if(asset.usageDays!==undefined) backups.push({ assetId: asset.id,backedUpAt: new Date().toISOString(),usageDays: asset.usageDays,purchaseDate: asset.purchaseDate });
    }
    if(next.legacyUsageDays!==undefined) recalculated+=1;
    return next;
  });
  return { normalized,migrated,recalculated,backups };
}

function GoalEntryModal({ type,onClose,onGoal,onAnnualPlan,data,goalDraft,setGoalDraft,annualPlanDraft,setAnnualPlanDraft }: { type: "goal"|"annual-plan"; onClose: () => void; onGoal: () => void; onAnnualPlan: () => void; data: WealthData; goalDraft: GoalDraft; setGoalDraft: Dispatch<SetStateAction<GoalDraft>>; annualPlanDraft: AnnualPlanDraft; setAnnualPlanDraft: Dispatch<SetStateAction<AnnualPlanDraft>>; }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(event.currentTarget===event.target) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="goal-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / PLAN</div><h2 id="goal-modal-title">{type==="goal"? "新增储蓄目标":"新增年度计划"}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{type==="goal"? <div className="form-stack"><label>目标名称<input placeholder="例如：旅行基金" value={goalDraft.name} onChange={(event) => setGoalDraft((draft) => ({ ...draft,name: event.target.value }))} /></label><div className="form-grid"><label>当前金额<input type="number" min="0" step="0.01" value={goalDraft.current} onChange={(event) => setGoalDraft((draft) => ({ ...draft,current: event.target.value }))} /></label><label>目标金额<input type="number" min="0" step="0.01" value={goalDraft.target} onChange={(event) => setGoalDraft((draft) => ({ ...draft,target: event.target.value }))} /></label></div><div className="form-grid"><label>币种<select value={goalDraft.currency} onChange={(event) => setGoalDraft((draft) => ({ ...draft,currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>目标周期<select value={goalDraft.cadence} onChange={(event) => setGoalDraft((draft) => ({ ...draft,cadence: event.target.value as Goal["cadence"] }))}><option value="weekly">每周</option><option value="monthly">每月</option><option value="quarterly">每季度</option><option value="yearly">每年</option><option value="custom">自定义周期</option><option value="once">一次性</option></select></label></div><div className="form-grid"><label>截止日期<input type="date" value={goalDraft.due} onChange={(event) => setGoalDraft((draft) => ({ ...draft,due: event.target.value }))} /></label><label>状态<select value={goalDraft.status} onChange={(event) => setGoalDraft((draft) => ({ ...draft,status: event.target.value as Goal["status"] }))}><option value="on-track">进行中</option><option value="watch">需要关注</option><option value="paused">已暂停</option></select></label></div><div className="form-grid"><label>开始日期<input type="date" value={goalDraft.startDate??goalDraft.due} onChange={(event) => setGoalDraft((draft) => ({ ...draft,startDate: event.target.value }))} /></label><label>周期金额<input type="number" min="0" step="0.01" value={goalDraft.periodAmount??""} onChange={(event) => setGoalDraft((draft) => ({ ...draft,periodAmount: event.target.value }))} placeholder="按周期建议金额（可选）" /></label></div><div className="form-grid"><label>优先级<select value={goalDraft.priority??"medium"} onChange={(event) => setGoalDraft((draft) => ({ ...draft,priority: event.target.value as NonNullable<Goal["priority"]> }))}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><label className="checkbox-label"><input type="checkbox" checked={goalDraft.isAutomatic??false} onChange={(event) => setGoalDraft((draft) => ({ ...draft,isAutomatic: event.target.checked }))} />自动加入未来计划</label></div><p className="form-help">保存后会按目标周期计算建议金额；删除或停用只会停止未来计划，不会删除历史储蓄。</p><button type="button" className="primary-button full" onClick={onGoal}>保存储蓄目标</button></div>:<div className="form-stack"><div className="form-grid"><label>年份<input type="number" min="2020" step="1" value={annualPlanDraft.year} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,year: event.target.value }))} /></label><label>月份<select value={annualPlanDraft.month} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,month: event.target.value }))}>{Array.from({ length: 12 },(_,index) => <option key={index+1} value={String(index+1)}>{index+1} 月</option>)}</select></label></div><label>计划名称<input placeholder="例如：保险年缴" value={annualPlanDraft.name} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,name: event.target.value }))} /></label><div className="form-grid"><label>分类<input placeholder="例如：保险" value={annualPlanDraft.category} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,category: event.target.value }))} /></label><label>金额<input type="number" min="0" step="0.01" value={annualPlanDraft.amount} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,amount: event.target.value }))} /></label></div><div className="form-grid"><label>币种<select value={annualPlanDraft.currency} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label><label>状态<select value={annualPlanDraft.status} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,status: event.target.value as AnnualPlanDraft["status"] }))}><option value="planned">待准备</option><option value="funded">已预留</option><option value="complete">已完成</option></select></label></div><label>关联目标<select value={annualPlanDraft.goalId} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,goalId: event.target.value }))}><option value="">不关联目标</option>{data.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select></label><label>备注<input placeholder="可选说明" value={annualPlanDraft.note} onChange={(event) => setAnnualPlanDraft((draft) => ({ ...draft,note: event.target.value }))} /></label><button type="button" className="primary-button full" onClick={onAnnualPlan}>保存年度计划</button></div>}</div></div>;
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN",{ month: "short",day: "numeric" }).format(new Date(`${date}T00:00:00`));
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function makeDeleteTarget(record: { kind: "income"|"expense"|"transfer"; record: Transaction|Transfer; }): Exclude<DeleteTarget,null> {
  return record.kind==="transfer"
    ? { kind: "transfer",record: record.record as Transfer }
    :{ kind: "transaction",record: record.record as Transaction };
}

function Stat({ icon: Icon,label,value,detail,tone="cyan" }: { icon: ElementType; label: string; value: string; detail: string; tone?: string; }) {
  return <div className="stat-cell"><div className={`stat-icon ${tone}`}><Icon size={18} weight="fill" /></div><div><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-hint">{detail}</div></div></div>;
}

export default function WealthAtlasV2() {
  const [data,setData]=useState<WealthData>(() => migrateWealthData({ ...initialData,assets: normalizeAssets(initialData.assets).normalized }));
  const [active,setActive]=useState(() => {
    if(typeof window==="undefined") return "home";
    try { return window.localStorage.getItem("wealth-atlas.active-section")??"home"; }
    catch { return "home"; }
  });
  const [fxMode,setFxMode]=useState(false);
  const [assetMode,setAssetMode]=useState(false);
  const [modal,setModal]=useState<ModalType>(null);
  const [toast,setToast]=useState<string|null>(null);
  const [toastAction,setToastAction]=useState<(() => void)|null>(null);
  const [toastActionLabel,setToastActionLabel]=useState("撤销删除");
  const [loaded,setLoaded]=useState(false);
  const [transactionFilter,setTransactionFilter]=useState<"all"|"income"|"expense">("all");
  const [transactionEditingId,setTransactionEditingId]=useState<string|null>(null);
  const [transferEditingId,setTransferEditingId]=useState<string|null>(null);
  const [accountEditingId,setAccountEditingId]=useState<string|null>(null);
  const [budgetEditingId,setBudgetEditingId]=useState<string|null>(null);
  const [goalEditingId,setGoalEditingId]=useState<string|null>(null);
  const [annualPlanEditingId,setAnnualPlanEditingId]=useState<string|null>(null);
  const [categoryManagerOpen,setCategoryManagerOpen]=useState(false);
  const [categoryEditingId,setCategoryEditingId]=useState<string|null>(null);
  const [categoryDraft,setCategoryDraft]=useState({ name: "",kind: "expense" as TransactionCategory["kind"],icon: "",color: "#d7aa6f" });
  const [recordDetails,setRecordDetails]=useState<RecordDetailState>(null);
  const [deleteTarget,setDeleteTarget]=useState<DeleteTarget>(null);
  const [permanentTarget,setPermanentTarget]=useState<DeleteTarget>(null);
  const [accountDeleteTarget,setAccountDeleteTarget]=useState<Account|null>(null);
  const [accountPermanentTarget,setAccountPermanentTarget]=useState<Account|null>(null);
  const [entityDeleteTarget,setEntityDeleteTarget]=useState<EntityDeleteTarget>(null);
  const [deleteInFlightKey,setDeleteInFlightKey]=useState<string|null>(null);
  const deleteInFlightRef=useRef<string|null>(null);
  const [migrationNotice,setMigrationNotice]=useState<string|null>(null);
  const [fxDraft,setFxDraft]=useState({ pair: "SGD/MYR",rate: "3.48",date: today,note: "" });
  const [transactionDraft,setTransactionDraft]=useState<TransactionDraft>({ type: "expense",accountId: "myr-main",amount: "",category: "外食",merchant: "",date: today,note: "" });
  const [transferDraft,setTransferDraft]=useState<TransferDraft>({ fromAccountId: "sgd-main",toAccountId: "myr-main",amount: "",rate: "3.48",fee: "5",feeCurrency: "SGD",date: today });
  const [accountDraft,setAccountDraft]=useState<AccountDraft>({ name: "",type: "bank",currency: "SGD",balance: "0" });
  const [budgetDraft,setBudgetDraft]=useState<BudgetDraft>({ month: currentMonth,category: "外食",limit: "800",currency: "MYR" });
  const [goalPeriodFilter,setGoalPeriodFilter]=useState<"all"|Goal["cadence"]>("all");
  const [planYear,setPlanYear]=useState(Number(currentMonth.slice(0,4)));
  const [goalDraft,setGoalDraft]=useState<GoalDraft>({ name: "",current: "0",target: "10000",currency: "MYR",due: `${Number(currentMonth.slice(0,4))}-12-31`,cadence: "monthly",status: "on-track" });
  const [annualPlanDraft,setAnnualPlanDraft]=useState<AnnualPlanDraft>({ year: String(Number(currentMonth.slice(0,4))),month: "12",name: "",category: "",amount: "0",currency: "MYR",status: "planned",goalId: "",note: "" });
  const [assetModal,setAssetModal]=useState(false);
  const [assetEditingId,setAssetEditingId]=useState<string|null>(null);
  const [assetDraft,setAssetDraft]=useState<AssetDraft>(emptyAssetDraft);
  const [assetCategoryFilter,setAssetCategoryFilter]=useState("all");
  const [assetStatusFilter,setAssetStatusFilter]=useState<"all"|"active"|"unused"|"sold">("all");

  useEffect(() => {
    loadWealthData().then((saved) => {
      if(saved) {
        const migratedData=migrateWealthData({ ...initialData,...saved,assets: saved.assets??initialData.assets });
        const assetMigration=normalizeAssets(migratedData.assets);
        setData({ ...migratedData,assets: assetMigration.normalized,assetMigrationBackups: [...(migratedData.assetMigrationBackups??[]),...assetMigration.backups.filter((backup) => !(migratedData.assetMigrationBackups??[]).some((item) => item.assetId===backup.assetId))] });
        if(migratedData.migrationNotices?.length) setMigrationNotice(migratedData.migrationNotices[migratedData.migrationNotices.length-1]);
        else if(assetMigration.migrated>0) setMigrationNotice(`已迁移 ${assetMigration.migrated} 项旧物品资产资料。${assetMigration.recalculated>0? ` ${assetMigration.recalculated} 项已按使用起算日期重新计算天数，旧值仍保存在本地备份字段中。`:""}`);
      }
      setLoaded(true);
    });
  },[]);

  useEffect(() => {
    if(typeof window!=="undefined") {
      try { window.localStorage.setItem("wealth-atlas.active-section",active); }
      catch { /* Navigation remains usable when browser storage is unavailable. */ }
    }
  },[active]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js");
      return;
    }

    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(
        registrations
          .filter((registration) => registration.scope.startsWith(window.location.origin))
          .map((registration) => registration.unregister()),
      ),
    );

    if ("caches" in window) {
      void window.caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("wealth-atlas-shell-"))
            .map((key) => window.caches.delete(key)),
        ),
      );
    }
  },[]);

  useEffect(() => {
    if(active==="fx") {
      setFxMode(true);
      setAssetMode(false);
    } else if(active==="assets") {
      setFxMode(false);
      setAssetMode(true);
    } else if(active!=="settings") {
      setFxMode(false);
      setAssetMode(false);
    }
  },[active]);

  useEffect(() => { if(loaded) void saveWealthData(data); },[data,loaded]);
  useEffect(() => { if(!toast) return; const timeout=window.setTimeout(() => setToast(null),3200); return () => window.clearTimeout(timeout); },[toast]);

  const reportCurrency=data.reportCurrency;
  const monthTransactions=useMemo(() => getMonthTransactions(data,currentMonth),[data]);
  const monthlyIncome=totalIncomeInCurrency({ ...data,transactions: monthTransactions },reportCurrency);
  const monthlyExpenses=totalExpensesInCurrency({ ...data,transactions: monthTransactions },reportCurrency);
  const liquidBalance=getLiquidBalanceInCurrency(data,reportCurrency);
  const freeToSpend=calculateFreeToSpend(data,currentMonth,today);
  const netWorth=totalInCurrency(data,reportCurrency)+data.assets.filter((asset) => !asset.deleted).reduce((sum,asset) => sum+(convert(asset.currentValue,asset.currency,reportCurrency,data.fxRates)??0),0);
  const monthlyBudgets=(data.budgets??[]).filter((budget) => (budget.period??budget.month)===currentMonth&&budget.active!==false&&budget.status!=="inactive"&&budget.status!=="deleted"&&!budget.deleted);
  const budgetRemaining=monthlyBudgets.reduce((sum,budget) => sum+(convert(getBudgetRemaining(data,budget),budget.currency,reportCurrency,data.fxRates)??0),0);
  const upcomingPayments=getUpcomingPlannedPayments(data,currentMonth,today);
  const upcomingTotal=upcomingPayments.reduce((sum,payment) => sum+(convert(payment.amount,payment.currency,reportCurrency,data.fxRates)??0),0);
  const latestSgdMyr=getRate(data.fxRates,"SGD","MYR")??0;
  const latestUsdSgd=getRate(data.fxRates,"USD","SGD")??0;
  const currencyExposures=getCurrencyExposures(data,reportCurrency);
  const activeAccounts=data.accounts.filter((account) => account.status!=="inactive"&&account.status!=="deleted");
  const transactionCategories=data.categories??[];
  const availableCategories=transactionCategories.filter((category) => category.kind===transactionDraft.type&&category.active!==false);

  const showToast=(message: string,action?: () => void,actionLabel="撤销删除") => { setToast(message); setToastAction(action? () => action:null); setToastActionLabel(actionLabel); };
  useEffect(() => { if(migrationNotice) showToast(migrationNotice); },[migrationNotice]);
  const openTransaction=(transaction?: Transaction|{ preventDefault?: () => void; }) => {
    const selectedTransaction=transaction&&"amount" in transaction? transaction:undefined;
    if(selectedTransaction) {
      setTransactionEditingId(selectedTransaction.id);
      setTransactionDraft({ type: selectedTransaction.type,accountId: selectedTransaction.accountId,amount: String(selectedTransaction.amount),category: selectedTransaction.category,categoryId: selectedTransaction.categoryId??data.categories?.find((item) => item.kind===selectedTransaction.type&&item.name===selectedTransaction.category)?.id,merchant: selectedTransaction.merchant??"",date: selectedTransaction.date,note: selectedTransaction.note??"" });
    } else {
      setTransactionEditingId(null);
      setTransactionDraft((draft) => { const category=data.categories?.find((item) => item.id===draft.categoryId&&item.kind===draft.type)??data.categories?.find((item) => item.kind===draft.type&&item.active!==false); return { ...draft,accountId: draft.accountId||activeAccounts[0]?.id||"",categoryId: category?.id,category: category?.name??draft.category,date: today }; });
    }
    setModal("transaction");
  };
  const openTransfer=(transfer?: Transfer) => {
    if(transfer) {
      setTransferEditingId(transfer.id);
      setTransferDraft({ fromAccountId: transfer.fromAccountId,toAccountId: transfer.toAccountId,amount: String(transfer.fromAmount),rate: String(transfer.inputRate??transfer.rate),fee: String(transfer.fee),feeCurrency: transfer.feeCurrency,date: transfer.date });
    } else {
      setTransferEditingId(null);
      setTransferDraft((draft) => ({ ...draft,date: today }));
    }
    setModal("transfer");
  };

  const addTransaction=() => {
    const amount=Number(transactionDraft.amount);
    const account=getAccount(data,transactionDraft.accountId);
    if(!account||!amount||amount<=0||!transactionDraft.category.trim()) return showToast("请填写账户、金额和分类");
    const rateRecord=getRateRecord(data.fxRates,account.currency,reportCurrency,transactionDraft.date);
    const historicalRate=getRateAtDate(data.fxRates,account.currency,reportCurrency,transactionDraft.date);
    const convertedAmount=historicalRate===null? amount:amount*historicalRate;
    const fxSnapshot=createFxSnapshot({ amount,originalCurrency: account.currency,convertedAmount,convertedCurrency: reportCurrency,date: rateRecord?.effectiveDate??transactionDraft.date,rate: historicalRate??1,rateId: rateRecord?.id,source: rateRecord?.source??"缺少汇率" });
    const category=data.categories?.find((item) => item.id===transactionDraft.categoryId&&item.kind===transactionDraft.type)??data.categories?.find((item) => item.name===transactionDraft.category.trim()&&item.kind===transactionDraft.type);
    const transaction: Transaction={ id: transactionEditingId??makeId("transaction"),type: transactionDraft.type,accountId: account.id,amount,currency: account.currency,category: category?.name??transactionDraft.category.trim(),categoryId: category?.id??transactionDraft.categoryId,merchant: transactionDraft.merchant.trim()||undefined,date: transactionDraft.date,note: transactionDraft.note.trim()||undefined,convertedAmount,convertedCurrency: reportCurrency,fxRate: historicalRate??undefined,fxSnapshot };
    setData((current) => ({ ...current,transactions: transactionEditingId? current.transactions.map((item) => item.id===transactionEditingId? transaction:item):[transaction,...current.transactions] }));
    setModal(null);
    setTransactionEditingId(null);
    showToast(transactionEditingId? "交易已更新，账户余额已重新计算":"交易已保存，账户余额已更新");
  };

  const addTransfer=() => {
    const amount=Number(transferDraft.amount);
    const rate=Number(transferDraft.rate);
    const fee=Number(transferDraft.fee)||0;
    const from=getAccount(data,transferDraft.fromAccountId);
    const to=getAccount(data,transferDraft.toAccountId);
    if(!from||!to) return showToast("请选择有效的转出和转入账户");
    const feeCurrency=transferDraft.feeCurrency===to.currency? to.currency:from.currency;
    const grossReceived=amount*rate;
    const receivedAmount=Math.max(0,grossReceived-(feeCurrency===to.currency? fee:0));
    const effectiveRate=getTransferEffectiveRate(amount,receivedAmount,fee,feeCurrency,from.currency);
    if(!from||!to||from.id===to.id||!amount||amount<=0||!rate||rate<=0||fee<0||receivedAmount<=0) return showToast("请填写有效的转账账户、金额、手续费和汇率");
    const rateRecord=getRateRecord(data.fxRates,from.currency,to.currency,transferDraft.date);
    const fxSnapshot=createFxSnapshot({ amount,originalCurrency: from.currency,convertedAmount: receivedAmount,convertedCurrency: to.currency,date: rateRecord?.effectiveDate??transferDraft.date,rate,rateId: rateRecord?.id,source: rateRecord? "手动输入":"单笔覆盖",fee,feeCurrency });
    const transfer: Transfer={ id: transferEditingId??makeId("transfer"),fromAccountId: from.id,toAccountId: to.id,fromAmount: amount,fromCurrency: from.currency,toAmount: receivedAmount,toCurrency: to.currency,rate,fee,feeCurrency,date: transferDraft.date,inputRate: rate,actualRate: amount>0? grossReceived/amount:rate,effectiveRate,rateDate: rateRecord?.effectiveDate??transferDraft.date,rateSource: rateRecord?.source??"单笔覆盖",fxSnapshot };
    setData((current) => ({ ...current,transfers: transferEditingId? current.transfers.map((item) => item.id===transferEditingId? transfer:item):[transfer,...current.transfers] }));
    setModal(null);
    setTransferEditingId(null);
    showToast(transferEditingId? `${from.currency} 转账已更新，两个账户余额已重新计算`:`${from.currency} 转账已保存，两个账户余额已联动`);
  };

  const beginDelete=(key: string) => {
    if(deleteInFlightRef.current) return false;
    deleteInFlightRef.current=key;
    setDeleteInFlightKey(key);
    return true;
  };

  const finishDelete=() => {
    deleteInFlightRef.current=null;
    setDeleteInFlightKey(null);
  };

  const restoreRecord=(target: DeleteTarget) => {
    if(!target) return;
    setData((current) => target.kind==="transaction"
      ? { ...current,transactions: current.transactions.map((item) => item.id===target.record.id? { ...item,deleted: false,deletedAt: undefined }:item) }
      :{ ...current,transfers: current.transfers.map((item) => item.id===target.record.id? { ...item,deleted: false,deletedAt: undefined }:item) });
    showToast("记录已恢复，余额与统计已重新计入");
  };

  const softDeleteRecord=() => {
    const target=deleteTarget;
    if(!target||!beginDelete(`record:${target.kind}:${target.record.id}`)) return;
    const deletedAt=new Date().toISOString();
    try {
      setData((current) => target.kind==="transaction"
        ? { ...current,transactions: current.transactions.map((item) => item.id===target.record.id? { ...item,deleted: true,deletedAt }:item) }
        :{ ...current,transfers: current.transfers.map((item) => item.id===target.record.id? { ...item,deleted: true,deletedAt }:item) });
      setDeleteTarget(null);
      showToast("记录已移入回收站，余额与预算已更新",() => restoreRecord(target));
    } catch {
      showToast("删除失败，原始资料未改变");
    } finally {
      finishDelete();
    }
  };

  const permanentlyDeleteRecord=() => {
    const target=permanentTarget;
    if(!target||!beginDelete(`permanent:${target.kind}:${target.record.id}`)) return;
    try {
      setData((current) => target.kind==="transaction"
        ? { ...current,transactions: current.transactions.filter((item) => item.id!==target.record.id) }
        :{ ...current,transfers: current.transfers.filter((item) => item.id!==target.record.id) });
      setPermanentTarget(null);
      showToast("记录已永久删除");
    } catch {
      showToast("永久删除失败，原始资料未改变");
    } finally {
      finishDelete();
    }
  };

  const openAccount=(account?: Account) => {
    if(account) {
      setAccountEditingId(account.id);
      setAccountDraft({ name: account.name,type: account.type,currency: account.currency,balance: String(account.balance),accountGroup: account.accountGroup??"",parentAccountId: account.parentAccountId??"",institution: account.institution??"",includeInNetWorth: account.includeInNetWorth!==false });
    } else {
      setAccountEditingId(null);
      setAccountDraft({ name: "",type: "bank",currency: "SGD",balance: "0",accountGroup: "",parentAccountId: "",institution: "",includeInNetWorth: true });
    }
    setModal("account");
  };

  const openBudget=(budget?: MonthlyBudget) => {
    if(budget) {
      setBudgetEditingId(budget.id);
      setBudgetDraft({ month: budget.month,category: budget.category,categoryId: budget.categoryId,limit: String(budget.budgetAmount??budget.limit),budgetAmount: String(budget.budgetAmount??budget.limit),currency: budget.currency,period: budget.period??budget.month });
    } else {
      setBudgetEditingId(null);
      const category=data.categories?.find((item) => item.kind==="expense"&&item.active!==false&&item.name==="外食")??data.categories?.find((item) => item.kind==="expense"&&item.active!==false);
      setBudgetDraft({ month: currentMonth,category: category?.name??"外食",categoryId: category?.id,limit: "800",budgetAmount: "800",currency: "MYR",period: currentMonth });
    }
    setModal("budget");
  };

  const openGoal=(goal?: Goal) => {
    if(goal) {
      setGoalEditingId(goal.id);
      setGoalDraft({ name: goal.name,current: String(goal.current),target: String(goal.target),currency: goal.currency,due: goal.due,startDate: goal.startDate??today,endDate: goal.endDate??goal.due,periodAmount: goal.periodAmount===undefined? "":String(goal.periodAmount),priority: goal.priority??"medium",isAutomatic: goal.isAutomatic??false,cadence: goal.cadence,status: goal.status });
    } else {
      setGoalEditingId(null);
      setGoalDraft({ name: "",current: "0",target: "10000",currency: "MYR",due: `${Number(currentMonth.slice(0,4))}-12-31`,startDate: today,endDate: `${Number(currentMonth.slice(0,4))}-12-31`,periodAmount: "",priority: "medium",isAutomatic: false,cadence: "monthly",status: "on-track" });
    }
    setModal("goal");
  };

  const saveCategory=() => {
    const name=categoryDraft.name.trim();
    if(!name) return showToast("请填写分类名称");
    setData((current) => {
      const id=categoryEditingId??makeId("category");
      const existing=current.categories?.find((item) => item.id===id);
      const category: TransactionCategory={ id,name,kind: categoryDraft.kind,icon: categoryDraft.icon.trim()||undefined,color: categoryDraft.color,active: true,createdAt: existing?.createdAt??new Date().toISOString(),updatedAt: new Date().toISOString() };
      const categories=categoryEditingId? (current.categories??[]).map((item) => item.id===categoryEditingId? category:item):[...(current.categories??[]),category];
      const transactions=categoryEditingId? current.transactions.map((item) => item.categoryId===categoryEditingId? { ...item,category: name }:item):current.transactions;
      return { ...current,categories,transactions };
    });
    setCategoryDraft({ name: "",kind: "expense",icon: "",color: "#d7aa6f" });
    setCategoryEditingId(null);
    showToast(categoryEditingId? "分类已更新，历史记录保留":"分类已添加");
  };

  const requestEntityDelete=(target: Exclude<EntityDeleteTarget,null>) => {
    if(deleteInFlightRef.current) return;
    setEntityDeleteTarget(target);
  };

  const confirmEntityDelete=() => {
    const target=entityDeleteTarget;
    if(!target||!beginDelete(`entity:${target.kind}:${target.id}`)) return;
    const deletedAt=new Date().toISOString();
    if(target.kind==="category"&&target.action==="permanent") {
      const category=(data.categories??[]).find((item) => item.id===target.id);
      const inUse=data.transactions.some((item) => item.categoryId===target.id);
      if(!category?.createdAt||inUse) {
        finishDelete();
        showToast("该分类仍被历史交易引用，只能停用，原始资料未改变");
        return;
      }
    }
    try {
      setData((current) => {
        if(target.kind==="category") {
          const category=(current.categories??[]).find((item) => item.id===target.id);
          const inUse=current.transactions.some((item) => item.categoryId===target.id);
          if(target.action==="permanent") {
            if(!category?.createdAt||inUse) return current;
            return { ...current,categories: (current.categories??[]).filter((item) => item.id!==target.id) };
          }
          return { ...current,categories: (current.categories??[]).map((item) => item.id===target.id? { ...item,active: false,updatedAt: new Date().toISOString() }:item) };
        }
        if(target.kind==="budget") {
          if(target.action==="permanent") return { ...current,budgets: (current.budgets??[]).filter((item) => item.id!==target.id) };
          return { ...current,budgets: (current.budgets??[]).map((item) => item.id===target.id? target.action==="deactivate"? { ...item,active: false,status: "inactive" }:{ ...item,active: false,status: "deleted",deleted: true,deletedAt }:item) };
        }
        if(target.kind==="goal") {
          if(target.action==="permanent") return { ...current,goals: current.goals.filter((item) => item.id!==target.id) };
          return { ...current,goals: current.goals.map((item) => item.id===target.id? target.action==="deactivate"? { ...item,active: false,deleted: false,deletedAt: undefined }:{ ...item,active: false,deleted: true,deletedAt }:item) };
        }
        if(target.kind==="annual-plan") {
          if(target.action==="permanent") return { ...current,annualPlans: (current.annualPlans??[]).filter((item) => item.id!==target.id) };
          return { ...current,annualPlans: (current.annualPlans??[]).map((item) => item.id===target.id
            ? target.action==="deactivate" ? { ...item,active: false,deleted: false,deletedAt: undefined } : { ...item,active: false,deleted: true,deletedAt }
            : item) };
        }
        if(target.action==="permanent") return { ...current,assets: current.assets.filter((item) => item.id!==target.id) };
        return { ...current,assets: current.assets.map((item) => item.id===target.id? { ...item,deleted: true,deletedAt }:item) };
      });
      setEntityDeleteTarget(null);
      const messages=target.kind==="category"
        ? target.action==="permanent"? "自定义分类已永久删除，历史交易未改变":"分类已停用，历史记录仍然保留"
        :target.kind==="budget"
          ? target.action==="deactivate"? "预算已停用，历史统计保留":target.action==="permanent"? "预算已永久删除，交易记录未改变":"预算已移入回收区"
          :target.kind==="goal"? target.action==="deactivate"? "目标周期已停用，历史储蓄记录保留":target.action==="permanent"? "目标周期已永久删除，历史储蓄记录未改变":"储蓄目标已移入回收区，历史记录保留"
            :target.kind==="annual-plan"? target.action==="deactivate"? "年度计划已停用，可在恢复区继续管理":target.action==="permanent"? "年度计划已永久删除，关联目标与交易未改变":"年度计划已移入恢复区"
            :target.action==="permanent"? "物品资产已永久删除":"物品资产已移入恢复区";
      showToast(messages);
    } catch {
      showToast("删除失败，原始资料未改变");
    } finally {
      finishDelete();
    }
  };

  const restoreCategory=(category: TransactionCategory) => {
    setData((current) => ({ ...current,categories: (current.categories??[]).map((item) => item.id===category.id? { ...item,active: true,updatedAt: new Date().toISOString() }:item) }));
    showToast("分类已恢复");
  };

  const addAccount=() => {
    const balance=Number(accountDraft.balance);
    if(!accountDraft.name.trim()||!Number.isFinite(balance)) return showToast("请填写账户名称和有效余额");
    const account={ id: accountEditingId??makeId("account"),name: accountDraft.name.trim(),type: accountDraft.type,currency: accountDraft.currency,balance,accountGroup: accountDraft.accountGroup?.trim()||undefined,parentAccountId: accountDraft.parentAccountId||undefined,institution: accountDraft.institution?.trim()||undefined,includeInNetWorth: accountDraft.includeInNetWorth!==false,status: "active" as const };
    setData((current) => ({ ...current,accounts: accountEditingId? current.accounts.map((item) => item.id===accountEditingId? { ...item,...account }:item):[...current.accounts,account] }));
    setAccountDraft({ name: "",type: "bank",currency: "SGD",balance: "0",accountGroup: "",parentAccountId: "",institution: "",includeInNetWorth: true });
    setModal(null);
    setAccountEditingId(null);
    showToast(accountEditingId? "账户资料已更新，历史记录未改变":"账户已添加");
  };

  const addBudget=() => {
    const limit=Number(budgetDraft.limit);
    if(!budgetDraft.category.trim()||!budgetDraft.month||!limit||limit<=0) return showToast("请填写预算月份、分类和限额");
    const budget={ id: budgetEditingId??makeId("budget"),month: budgetDraft.month,category: budgetDraft.category.trim(),categoryId: budgetDraft.categoryId,period: budgetDraft.period??budgetDraft.month,budgetAmount: limit,limit,currency: budgetDraft.currency,active: true as const,status: "active" as const };
    setData((current) => ({ ...current,budgets: budgetEditingId? (current.budgets??[]).map((item) => item.id===budgetEditingId? { ...item,...budget }:item):[...(current.budgets??[]),budget] }));
    setModal(null);
    setBudgetEditingId(null);
    showToast(budgetEditingId? "预算已更新":"月度预算已保存");
  };

  const addGoal=() => {
    const current=Number(goalDraft.current);
    const target=Number(goalDraft.target);
    if(!goalDraft.name.trim()||!Number.isFinite(current)||!Number.isFinite(target)||current<0||target<=0||current>target||!goalDraft.due) return showToast("请填写有效的目标名称、金额和截止日期");
    const goal: Goal={ id: goalEditingId??makeId("goal"),name: goalDraft.name.trim(),current,target,currency: goalDraft.currency,percent: Math.round(target>0? (current/target)*100:0),due: goalDraft.endDate||goalDraft.due,endDate: goalDraft.endDate||goalDraft.due,startDate: goalDraft.startDate||today,periodAmount: goalDraft.periodAmount? Number(goalDraft.periodAmount):undefined,priority: goalDraft.priority??"medium",isAutomatic: goalDraft.isAutomatic??false,cadence: goalDraft.cadence,status: goalDraft.status,active: true };
    setData((currentData) => ({ ...currentData,goals: goalEditingId? currentData.goals.map((item) => item.id===goalEditingId? { ...item,...goal }:item):[...currentData.goals,goal] }));
    setGoalDraft({ name: "",current: "0",target: "10000",currency: "MYR",due: `${Number(currentMonth.slice(0,4))}-12-31`,startDate: today,endDate: `${Number(currentMonth.slice(0,4))}-12-31`,periodAmount: "",priority: "medium",isAutomatic: false,cadence: "monthly",status: "on-track" });
    setModal(null);
    setGoalEditingId(null);
    showToast(goalEditingId? "储蓄目标周期已更新":"储蓄目标已保存");
  };

  const archiveAccount=(account: Account) => {
    if(deleteInFlightRef.current) return;
    setAccountDeleteTarget(account);
  };

  const confirmArchiveAccount=() => {
    const target=accountDeleteTarget;
    if(!target||!beginDelete(`account:${target.id}`)) return;
    try {
      setData((current) => {
        const hasHistory=getAccountHistoryCount(current,target.id)>0;
        const timestamp=new Date().toISOString();
        return { ...current,accounts: current.accounts.map((item) => item.id===target.id? { ...item,status: hasHistory? "inactive":"deleted",deactivatedAt: timestamp,deletedAt: hasHistory? undefined:timestamp }:item) };
      });
      showToast("账户状态已更新，历史记录未删除");
      setAccountDeleteTarget(null);
    } catch {
      showToast("账户操作失败，原始资料未改变");
    } finally {
      finishDelete();
    }
  };

  const restoreAccount=(account: Account) => {
    setData((current) => ({ ...current,accounts: current.accounts.map((item) => item.id===account.id? { ...item,status: "active",deletedAt: undefined,deactivatedAt: undefined }:item) }));
    showToast("账户已恢复");
  };

  const permanentlyDeleteAccount=async (account: Account) => {
    if(!beginDelete(`permanent-account:${account.id}`)) return;
    try {
      if(!canPermanentlyDeleteAccount(data,account.id)) {
        showToast("账户已有历史记录或关联子账户，无法永久删除");
        return;
      }
      const nextData={ ...data,accounts: data.accounts.filter((item) => item.id!==account.id) };
      await saveWealthData(nextData);
      setData(nextData);
      setAccountPermanentTarget(null);
      showToast("账户已永久删除，其他账户与财务历史未改变");
    } catch {
      showToast("永久删除账户失败，原始资料未改变");
    } finally {
      finishDelete();
    }
  };

  const archiveBudget=(budget: MonthlyBudget) => {
    requestEntityDelete({ kind: "budget",id: budget.id,action: "deactivate" });
  };

  const restoreBudget=(budget: MonthlyBudget) => {
    setData((current) => ({ ...current,budgets: (current.budgets??[]).map((item) => item.id===budget.id? { ...item,active: true,status: "active",deleted: false }:item) }));
    showToast("预算已恢复");
  };

  const deleteBudget=(budget: MonthlyBudget) => {
    requestEntityDelete({ kind: "budget",id: budget.id,action: "delete" });
  };

  const stopGoal=(goal: Goal) => {
    requestEntityDelete({ kind: "goal",id: goal.id,action: "deactivate" });
  };

  const deleteGoal=(goal: Goal) => {
    requestEntityDelete({ kind: "goal",id: goal.id,action: "delete" });
  };

  const archiveGoal=deleteGoal;

  const restoreGoal=(goal: Goal) => {
    setData((current) => ({ ...current,goals: current.goals.map((item) => item.id===goal.id? { ...item,active: true,deleted: false,deletedAt: undefined }:item) }));
    showToast("储蓄目标已恢复");
  };

  const openAnnualPlan=(plan?: AnnualPlan) => {
    if(plan) {
      setAnnualPlanEditingId(plan.id);
      setAnnualPlanDraft({ year: String(plan.year),month: String(plan.month),name: plan.name,category: plan.category,amount: String(plan.amount),currency: plan.currency,status: plan.status,goalId: plan.goalId??"",note: plan.note??"" });
    } else {
      setAnnualPlanEditingId(null);
      setAnnualPlanDraft({ year: String(planYear),month: "12",name: "",category: "",amount: "0",currency: "MYR",status: "planned",goalId: "",note: "" });
    }
    setModal("annual-plan");
  };

  const restoreAnnualPlan=(plan: AnnualPlan) => {
    setData((current) => ({ ...current,annualPlans: (current.annualPlans??[]).map((item) => item.id===plan.id? { ...item,active: true,deleted: false,deletedAt: undefined }:item) }));
    showToast("年度计划已恢复");
  };

  const addAnnualPlan=() => {
    const year=Number(annualPlanDraft.year);
    const month=Number(annualPlanDraft.month);
    const amount=Number(annualPlanDraft.amount);
    if(!annualPlanDraft.name.trim()||!annualPlanDraft.category.trim()||!Number.isInteger(year)||year<2020||!Number.isInteger(month)||month<1||month>12||!amount||amount<=0) return showToast("请填写有效的年度计划名称、月份和金额");
    const existingPlan=data.annualPlans?.find((item) => item.id===annualPlanEditingId);
    const nextPlan: AnnualPlan={ id: annualPlanEditingId??makeId("annual-plan"),year,month,name: annualPlanDraft.name.trim(),category: annualPlanDraft.category.trim(),amount,currency: annualPlanDraft.currency,status: annualPlanDraft.status,goalId: annualPlanDraft.goalId||undefined,note: annualPlanDraft.note.trim()||undefined,active: existingPlan?.active !== false,deleted: false,deletedAt: undefined };
    setData((currentData) => ({ ...currentData,annualPlans: annualPlanEditingId? (currentData.annualPlans??[]).map((item) => item.id===annualPlanEditingId? nextPlan:item):[...(currentData.annualPlans??[]),nextPlan] }));
    setAnnualPlanDraft({ year: String(planYear),month: "12",name: "",category: "",amount: "0",currency: "MYR",status: "planned",goalId: "",note: "" });
    setModal(null);
    setAnnualPlanEditingId(null);
    showToast(annualPlanEditingId? "年度计划已更新":"年度计划已保存");
  };

  const openAsset=(asset?: WealthData["assets"][number]) => {
    if(asset) {
      setAssetEditingId(asset.id);
      setAssetDraft({ name: asset.name,category: asset.category,purchaseValue: String(asset.purchaseValue),purchaseCurrency: getAssetPurchaseCurrency(asset),purchaseDate: asset.purchaseDate??today,usageStartMode: asset.usageStartMode??"purchaseDate",usageStartDate: asset.usageStartDate??asset.purchaseDate??today,currentValue: String(asset.currentValue),currentCurrency: getAssetCurrentCurrency(asset),sellPrice: asset.sellPrice===undefined? "":String(asset.sellPrice),saleDate: asset.saleDate??today,usageDays: String(asset.usageDays),useCount: String(asset.useCount??0),status: asset.status,note: asset.note??"" });
    } else {
      setAssetEditingId(null);
      setAssetDraft(emptyAssetDraft());
    }
    setAssetModal(true);
  };

  const saveAsset=() => {
    const purchaseValue=Number(assetDraft.purchaseValue);
    const currentValue=Number(assetDraft.currentValue);
    const sellPrice=assetDraft.sellPrice.trim()===""? undefined:Number(assetDraft.sellPrice);
    const useCount=Number(assetDraft.useCount);
    const usageStartDate=assetDraft.usageStartMode==="purchaseDate"? assetDraft.purchaseDate:assetDraft.usageStartDate;
    if(!assetDraft.name.trim()||!assetDraft.category.trim()||!Number.isFinite(purchaseValue)||purchaseValue<0||!Number.isFinite(currentValue)||currentValue<0||!Number.isFinite(useCount)||useCount<0||!Number.isInteger(useCount)||!assetDraft.purchaseDate||!usageStartDate) return showToast("请填写资产名称、价格、买入日期和使用起算日期");
    if(assetDraft.status==="sold"&&(!assetDraft.saleDate||sellPrice===undefined)) return showToast("已出售资产需要填写出售价格和出售日期");
    if(sellPrice!==undefined&&(!Number.isFinite(sellPrice)||sellPrice<0)) return showToast("请输入有效的卖出价格");
    const usageDays=getAssetUsageDays({ purchaseDate: assetDraft.purchaseDate,usageStartMode: assetDraft.usageStartMode,usageStartDate,saleDate: assetDraft.saleDate||undefined,status: assetDraft.status },today);
    const asset={ id: assetEditingId??makeId("asset"),name: assetDraft.name.trim(),category: assetDraft.category.trim(),purchaseValue,purchaseCurrency: assetDraft.purchaseCurrency,purchaseDate: assetDraft.purchaseDate,usageStartMode: assetDraft.usageStartMode,usageStartDate,currentValue,currentCurrency: assetDraft.currentCurrency,currency: assetDraft.currentCurrency,sellPrice,saleDate: assetDraft.status==="sold"? assetDraft.saleDate:undefined,usageDays,useCount,dailyCost: getAssetDailyCost({ purchaseValue,currentValue,sellPrice,purchaseDate: assetDraft.purchaseDate,usageStartMode: assetDraft.usageStartMode,usageStartDate,saleDate: assetDraft.saleDate||undefined,status: assetDraft.status },today),costPerUse: getAssetCostPerUse({ purchaseValue,currentValue,sellPrice,purchaseDate: assetDraft.purchaseDate,usageStartMode: assetDraft.usageStartMode,usageStartDate,saleDate: assetDraft.saleDate||undefined,status: assetDraft.status,useCount },today)??undefined,status: assetDraft.status,note: assetDraft.note.trim()||undefined };
    setData((current) => ({ ...current,assets: assetEditingId? current.assets.map((item) => item.id===assetEditingId? asset:item):[asset,...current.assets] }));
    setAssetModal(false);
    setAssetEditingId(null);
    setAssetDraft(emptyAssetDraft());
    showToast(assetEditingId? "物品资产已更新":"物品资产已保存");
  };

  const deleteAsset=(asset: WealthData["assets"][number]) => {
    requestEntityDelete({ kind: "asset",id: asset.id,action: "delete" });
  };

  const saveFxRate=() => {
    const rate=Number(fxDraft.rate);
    if(!rate||rate<=0) return showToast("请输入有效汇率");
    const [baseCurrency,quoteCurrency]=fxDraft.pair.split("/") as [CurrencyCode,CurrencyCode];
    const enteredAt=new Date().toISOString();
    setData((current) => ({ ...current,fxRates: [...current.fxRates.map((item) => item.baseCurrency===baseCurrency&&item.quoteCurrency===quoteCurrency? { ...item,isDefault: false }:item),{ id: makeId("fx"),baseCurrency,quoteCurrency,rate,effectiveDate: fxDraft.date,enteredAt,source: "手动输入",note: fxDraft.note||undefined,isDefault: true,active: true,useCount: 0 }] }));
    setModal(null);
    showToast(`${fxDraft.pair} 手动汇率已更新`);
  };

  const renderHeader=(eyebrow: string,title: string,action?: { label: string; onClick: () => void; icon?: ElementType; }) => <header className="page-header module-header"><div><div className="breadcrumb">WEALTH ATLAS / {eyebrow}</div><h1>{title}</h1></div><div className="header-actions"><div className="month-select"><CalendarDots size={18} /> {currentMonth.replace("-","年")}月</div>{action&&<button type="button" className="primary-button compact" onClick={action.onClick}>{action.icon&&<action.icon size={17} weight="bold" />}{action.label}</button>}<div className="local-pill"><ShieldCheck size={17} weight="fill" /> 本地数据</div></div></header>;

  const renderHome=() => {
    const watchlistMetrics=data.watchlists.slice(0,3).map((watchlist) => getWatchlistMetrics(data,watchlist,currentMonth,today));
    const financeAlerts=getFinanceAlerts(data,today).slice(0,2);
    const homeModules: HomeLayoutItem[]=[
      { id: "free",label: "本月可自由使用",children: <section className="panel home-layout-panel home-free-panel"><div className="panel-kicker">本月可自由使用</div><div className="hero-number">{formatMoney(freeToSpend,reportCurrency)}</div><div className="hero-support">流动余额 <strong>{formatMoney(liquidBalance,reportCurrency)}</strong></div><div className="calculation-line"><span>预算剩余</span><b>- {formatMoney(budgetRemaining,reportCurrency)}</b><span>固定付款</span><b>- {formatMoney(upcomingTotal,reportCurrency)}</b></div><div className="hero-note"><Check size={15} weight="bold" /> 余额来自账户流水与转账的实时合计</div></section> },
      { id: "income",label: "本月收入",children: <section className="panel home-layout-panel home-stat-panel"><Stat icon={Wallet} label="本月收入" value={formatMoney(monthlyIncome,reportCurrency)} detail={`${monthTransactions.filter((item) => item.type==="income").length} 笔已关联账户`} /></section> },
      { id: "expense",label: "本月支出",children: <section className="panel home-layout-panel home-stat-panel"><Stat icon={Receipt} label="本月支出" value={formatMoney(monthlyExpenses,reportCurrency)} detail={`${monthTransactions.filter((item) => item.type==="expense").length} 笔已关联账户`} tone="amber" /></section> },
      { id: "net-worth",label: "净资产",children: <section className="panel home-layout-panel home-stat-panel"><Stat icon={ChartLineUp} label="净资产" value={formatMoney(netWorth,reportCurrency)} detail="含投资账户与物品资产" tone="violet" /></section> },
      { id: "budget",label: "预算剩余",children: <section className="panel home-layout-panel home-stat-panel"><Stat icon={Scales} label="预算剩余" value={formatMoney(budgetRemaining,reportCurrency)} detail={`${monthlyBudgets.length} 个本月预算`} tone="green" /></section> },
      { id: "accounts",label: "账户总览",children: <section className="panel home-layout-panel account-snapshot-panel"><div className="panel-title-row"><div><div className="panel-kicker">账户总览</div><h2>钱现在在哪里</h2></div><button type="button" className="icon-button" onClick={() => setActive("accounts")} aria-label="查看账户"><ArrowsLeftRight size={18} /></button></div><div className="account-snapshot-list">{activeAccounts.slice(0,4).map((account) => <div className="account-snapshot-row" key={account.id}><div className={`account-type-icon ${account.type}`}><Bank size={17} /></div><div><strong>{account.name}</strong><span>{account.currency} · {getAccountActivityCount(data,account.id)} 笔活动</span></div><b>{formatMoney(getAccountBalance(data,account.id),account.currency)}</b></div>)}</div></section> },
      { id: "sgd-myr",label: "SGD/MYR 汇率",children: <section className="panel home-layout-panel home-rate-panel"><div className="panel-kicker">SGD / MYR</div><strong>{latestSgdMyr? latestSgdMyr.toFixed(4):"暂无"}</strong><span>手动汇率 · 历史快照不变</span><button type="button" className="text-button" onClick={() => setActive("fx")}>打开汇率中心 <ArrowRight size={15} /></button></section> },
      { id: "usd-sgd",label: "USD/SGD 汇率",children: <section className="panel home-layout-panel home-rate-panel"><div className="panel-kicker">USD / SGD</div><strong>{latestUsdSgd? latestUsdSgd.toFixed(4):"暂无"}</strong><span>手动汇率 · 投资换算路径</span><button type="button" className="text-button" onClick={() => setActive("fx")}>打开汇率中心 <ArrowRight size={15} /></button></section> },
      { id: "currency",label: "货币暴露",children: <section className="panel home-layout-panel currency-mini-panel"><div className="panel-title-row"><div><div className="panel-kicker">CURRENCY MAP</div><h2>货币暴露</h2></div><button type="button" className="text-button" onClick={() => setActive("fx")}>查看详情 <ArrowRight size={15} /></button></div><div className="currency-mini-list">{currencyExposures.map((row) => <div className="currency-mini-row" key={row.currency}><div><strong>{row.currency}</strong><span>{row.percent.toFixed(0)}%</span></div><div className="currency-mini-track"><span style={{ width: `${row.percent}%` }} /></div><small>{formatMoney(row.value,reportCurrency)} 报告价值</small></div>)}</div></section> },
      { id: "recent",label: "最近收支记录",children: <section className="panel home-layout-panel assets-panel"><div className="panel-title-row"><div><div className="panel-kicker">本月活动</div><h2>最近收支记录</h2></div><button type="button" className="text-button" onClick={() => setActive("transactions")}>查看全部 <ArrowsLeftRight size={16} /></button></div><div className="activity-list">{monthTransactions.slice(0,5).map((item) => <div className="activity-row" key={item.id}><div className={`activity-icon ${item.type}`}><Receipt size={17} /></div><div><strong>{item.merchant||item.category}</strong><span>{item.category} · {getAccount(data,item.accountId)?.name||"未关联"} · {formatDate(item.date)}</span></div><b className={item.type==="income"? "positive":"negative"}>{item.type==="income"? "+":"-"}{formatMoney(item.amount,item.currency)}</b></div>)}</div>{monthTransactions.length===0&&<div className="home-inline-empty">本月还没有收入或支出记录。</div>}</section> },
      { id: "watchlist",label: "Watchlist",children: <section className="panel home-layout-panel home-watchlist-panel"><div className="panel-title-row"><div><div className="panel-kicker">WATCHLIST</div><h2>支出警戒</h2></div><button type="button" className="text-button" onClick={() => setActive("watchlists")}>查看全部 <ArrowRight size={15} /></button></div>{watchlistMetrics.length? <div className="home-watchlist-list">{watchlistMetrics.map((item) => { const watchTone=item.overBudget? "risk":item.warning? "attention":"safe"; return <div className="home-watchlist-row" key={item.id}><div className="home-watchlist-heading"><strong>{item.name}</strong><span className={`home-watchlist-status ${watchTone}`}>{item.overBudget? "可能超支":item.warning? "接近警戒":"仍有空间"}</span></div><div className="home-watchlist-values"><span>本月已用<b>{formatMoney(item.monthSpent,item.currency)}</b></span><span>预算<b>{formatMoney(item.limit,item.currency)}</b></span><span>预计月底<b className={watchTone}>{formatMoney(item.forecastAtMonthEnd,item.currency)}</b></span></div><div className="home-watchlist-track"><span style={{ width: `${Math.min(100,item.limit? (item.monthSpent/item.limit)*100:0)}%` }} /></div></div>; })}</div>:<div className="home-inline-empty">还没有 Watchlist，从外食、购物或订阅开始追踪。</div>}</section> },
      { id: "reminders",label: "理财师提醒",children: <section className="panel home-layout-panel insight-panel"><div className="panel-title-row"><div><div className="panel-kicker">理财师提醒</div><h2>下一步看这里</h2></div><Bell size={21} className="sparkle" weight="fill" /></div>{financeAlerts.length? <div className="insight-list">{financeAlerts.map((alert) => { const destination=alert.id==="fx-stale"? "fx":alert.id.startsWith("watch-")? "watchlists":"cashflow"; return <div className={`insight-row home-alert-row ${alert.level}`} key={alert.id}><div className="insight-icon"><Bell size={16} /></div><div className="home-alert-copy"><span className="home-alert-type">{alert.level==="risk"? "资金风险":alert.level==="attention"? "需要关注":"财务提示"}</span><strong>{alert.title}</strong><span>{alert.detail}</span></div><button type="button" className="text-button home-alert-action" onClick={() => setActive(destination)} aria-label={`前往处理：${alert.title}`} title={`前往处理：${alert.title}`}>前往处理 <ArrowRight size={14} /></button></div>; })}</div>:<div className="home-inline-empty"><Check size={16} /> 当前没有需要优先处理的提醒。</div>}</section> },
      { id: "quick-actions",label: "快捷操作",children: <section className="panel home-layout-panel home-quick-actions-panel"><div className="panel-title-row"><div><div className="panel-kicker">QUICK CAPTURE</div><h2>现在要记录什么？</h2></div><Receipt size={20} className="sparkle" /></div><div className="home-action-grid"><button type="button" className="home-action-card primary" onClick={openTransaction}><Receipt size={18} /><span>记一笔</span><small>收入 / 支出</small></button><button type="button" className="home-action-card" onClick={() => openTransfer()}><ArrowsLeftRight size={18} /><span>SGD 转 MYR</span><small>记录转账</small></button><button type="button" className="home-action-card" onClick={() => setModal("fx")}><Coins size={18} /><span>更新汇率</span><small>手动输入</small></button><button type="button" className="home-action-card" onClick={() => openAccount()}><Wallet size={18} /><span>新增账户</span><small>连接余额</small></button><button type="button" className="home-action-card" onClick={() => setActive("insights")}><ChartLineUp size={18} /><span>记录投资</span><small>进入投资记录</small></button><button type="button" className="home-action-card" onClick={() => void exportExcel(data)}><FileXls size={18} /><span>导出 Excel</span><small>本地快照</small></button></div></section> },
    ];
    return <main className="main-content">
      {renderHeader("HOME","我的财富星图",{ label: "记一笔",onClick: openTransaction,icon: Plus })}
      <section className="home-quick-toolbar" aria-label="首页快捷操作">
        <div className="quick-toolbar-intro"><strong>快速记录</strong><span>把常用操作放在数据总览之前；操作只会写入本地设备。</span></div>
        <div className="quick-toolbar-grid">
          <button type="button" className="quick-toolbar-button primary" onClick={openTransaction} aria-label="记一笔收支" title="记一笔"><Receipt size={17}/><span>记一笔</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => openTransfer()} aria-label="记录 SGD 转 MYR" title="记录 SGD 转 MYR"><ArrowsLeftRight size={17}/><span>记转账</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => setModal("fx")} aria-label="更新手动汇率" title="更新汇率"><Coins size={17}/><span>更新汇率</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => openAccount()} aria-label="新增账户" title="新增账户"><Wallet size={17}/><span>新增账户</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => openGoal()} aria-label="新增储蓄目标" title="新增目标"><Target size={17}/><span>新增目标</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => setActive("obsidian")} aria-label="同步 Obsidian" title="同步 Obsidian"><ShieldCheck size={17}/><span>同步 Obsidian</span></button>
          <button type="button" className="quick-toolbar-button" onClick={() => void exportExcel(data)} aria-label="导出 Excel" title="导出 Excel"><FileXls size={17}/><span>导出 Excel</span></button>
        </div>
      </section>
      <HomeLayoutGrid items={homeModules} onNotify={showToast} />
    </main>;
  };

  const renderAccounts=() => {
    const archivedAccounts=data.accounts.filter((account) => account.status==="inactive"||account.status==="deleted");
    const groups=Array.from(new Set(activeAccounts.map((account) => account.accountGroup||"未分组")));

    return <>
      <main className="main-content module-page">
        {renderHeader("ACCOUNTS","账户管理",{ label: "新增账户",onClick: () => openAccount(),icon: Plus })}
        <section className="module-summary">
          <div><span>可用流动余额</span><strong>{formatMoney(liquidBalance,reportCurrency)}</strong><small>只计入当前启用的银行与现金账户</small></div>
          <div><span>全部账户净值</span><strong>{formatMoney(totalInCurrency(data,reportCurrency),reportCurrency)}</strong><small>按是否计入净资产计算</small></div>
          <div><span>启用账户</span><strong>{activeAccounts.length}</strong><small>{data.accounts.length} 个账户资料已保留</small></div>
        </section>
        <div className="module-toolbar account-ledger-toolbar">
          <div><div className="panel-kicker">BALANCE LEDGER</div><h2>余额由流水推导</h2></div>
          <p className="account-ledger-explanation">开户余额 + 收入 - 支出 - 转出 + 转入。账户改名只更新显示，不改变历史交易。</p>
        </div>
        {activeAccounts.length===0 ? <section className="panel empty-module-state"><h2>还没有启用账户</h2><p>新增账户后，这里会按分组与原始货币分别显示余额。</p></section> : groups.map((group) => {
          const groupAccounts=activeAccounts.filter((account) => (account.accountGroup||"未分组")===group);
          const groupCurrencies=Array.from(new Set(groupAccounts.map((account) => account.currency)));
          const groupBalanceSummary=groupCurrencies.map((currency) => {
            const balance=groupAccounts.filter((account) => account.currency===currency).reduce((sum,account) => sum+getAccountBalance(data,account.id),0);
            return formatMoney(balance,currency);
          }).join(" / ");
          const groupReportValue=groupAccounts.reduce((sum,account) => sum+(convert(getAccountBalance(data,account.id),account.currency,reportCurrency,data.fxRates)??0),0);

          return <section className="account-group-section" key={group}>
            <div className="section-heading">
              <div><div className="panel-kicker">ACCOUNT GROUP</div><h2>{group}</h2></div>
              <span>{groupAccounts.length} 个账户 · {groupBalanceSummary} · {reportCurrency} 报告价值 {formatMoney(groupReportValue,reportCurrency)}</span>
            </div>
            <section className="account-grid">
              {groupAccounts.map((account) => {
                const balance=getAccountBalance(data,account.id);
                const hasHistory=getAccountHistoryCount(data,account.id)>0;
                return <article className="panel account-card" key={account.id}>
                  <div className="account-card-top"><div className={"account-type-icon "+account.type}><Bank size={20} /></div><span className="currency-badge">{account.currency}</span></div>
                  <h3>{account.name}</h3>
                  <div className="account-balance">{formatMoney(balance,account.currency)}</div>
                  <div className="account-meta"><span>{accountTypeLabels[account.type]}</span><span>{account.institution||"未填写机构"}</span><span>{getAccountActivityCount(data,account.id)} 笔活动</span></div>
                  <div className="account-card-foot">
                    <span>{account.parentAccountId? "子账户 · "+(getAccount(data,account.parentAccountId)?.name??"未找到父账户"):"开户余额 "+formatMoney(account.balance,account.currency)}</span>
                    <div className="inline-actions">
                      <button type="button" className="text-button" onClick={() => openAccount(account)} aria-label={"编辑账户 "+account.name} title={"编辑账户 "+account.name}><PencilSimple size={15} /> 编辑</button>
                      <button type="button" className="text-button danger-text" onClick={() => archiveAccount(account)} aria-label={(hasHistory? "停用账户 ":"移入回收站 ")+account.name} title={(hasHistory? "停用账户 ":"移入回收站 ")+account.name}>{hasHistory? "停用账户":"移入回收站"}</button>
                      <button type="button" className="text-button" onClick={() => { setActive("transactions"); setTransactionFilter("all"); }} aria-label={"查看账户活动 "+account.name} title={"查看账户活动 "+account.name}>查看活动</button>
                    </div>
                  </div>
                </article>;
              })}
            </section>
          </section>;
        })}
        {archivedAccounts.length>0&&<section className="panel archived-records account-recovery-panel">
          <div className="panel-title-row account-recovery-header"><div><div className="panel-kicker">ACCOUNT RECOVERY</div><h2>停用与回收账户</h2><span>恢复后账户会重新启用；有历史记录的账户会保留资料。</span></div></div>
          <div className="account-recovery-list">
          {archivedAccounts.map((account) => {
            const canPermanentlyDelete=canPermanentlyDeleteAccount(data,account.id);
            const historyCount=getAccountHistoryCount(data,account.id);
            return <div className="archived-row account-recovery-row" key={account.id}>
              <div className="account-recovery-copy"><strong>{account.name}</strong><span>{account.currency} · {account.status==="deleted"? "已移入回收站":"已停用"} · 历史 {historyCount} 笔</span></div>
              <div className="inline-actions account-recovery-actions">
                <button type="button" className="secondary-button compact" onClick={() => restoreAccount(account)} aria-label={"恢复账户 "+account.name} title={"恢复账户 "+account.name}>恢复</button>
                {canPermanentlyDelete ? <button type="button" className="text-button danger-text account-permanent-delete-button" onClick={() => setAccountPermanentTarget(account)} aria-label={"永久删除账户 "+account.name} title={"永久删除账户 "+account.name}><Trash size={16} />永久删除</button> : <span className="archived-action-note">{historyCount>0? "有历史记录，保留资料":"有关联子账户，保留资料"}</span>}
              </div>
            </div>;
          })}
          </div>
        </section>}
      </main>
      {accountPermanentTarget&&<ProtectedDeleteDialog
        title="永久删除账户"
        titleId="permanent-account-delete-title"
        lead={"账户："+accountPermanentTarget.name}
        summary={<div className="confirm-record-summary"><div><span>账户货币</span><strong>{accountPermanentTarget.currency}</strong></div><div><span>账户状态</span><strong>{accountPermanentTarget.status==="deleted"? "已移入回收站":"已停用"}</strong></div><div><span>历史记录</span><strong>{getAccountHistoryCount(data,accountPermanentTarget.id)} 笔</strong></div></div>}
        warning="此操作无法恢复。只有没有交易、转账或子账户关联的账户才可以永久删除；不会删除其他财务资料。"
        confirmLabel="永久删除账户"
        onCancel={() => setAccountPermanentTarget(null)}
        onConfirm={() => permanentlyDeleteAccount(accountPermanentTarget)}
        isProcessing={Boolean(deleteInFlightKey)}
      />}
    </>;
  };

  const records=[...data.transactions.filter((item) => !item.deleted).map((item) => ({ kind: item.type,id: item.id,date: item.date,title: item.merchant||item.category,subtitle: `${item.category} · ${getAccount(data,item.accountId)?.name||"未关联账户"}`,amount: item.amount,currency: item.currency,record: item })),...data.transfers.filter((item) => !item.deleted).map((item) => ({ kind: "transfer" as const,id: item.id,date: item.date,title: `${getAccount(data,item.fromAccountId)?.name||item.fromCurrency} → ${getAccount(data,item.toAccountId)?.name||item.toCurrency}`,subtitle: `汇率 ${item.rate.toFixed(4)} · 手续费 ${formatMoney(item.fee,item.feeCurrency)}`,amount: item.fromAmount,currency: item.fromCurrency,record: item }))].filter((item) => transactionFilter==="all"||item.kind===transactionFilter).sort((a,b) => b.date.localeCompare(a.date));

  const renderTransactions=() => <main className="main-content module-page">{renderHeader("TRANSACTIONS","收支与转账",{ label: "记录收支",onClick: openTransaction,icon: Plus })}<div className="module-toolbar transaction-toolbar"><div><div className="panel-kicker">ACTIVITY LOG</div><h2>{records.length} 笔记录</h2></div><button type="button" className="secondary-button" onClick={() => openTransfer()}><ArrowsLeftRight size={17} /> 记录转账</button><button type="button" className="secondary-button" onClick={() => setCategoryManagerOpen(true)}><ListChecks size={17} /> 管理分类</button></div><div className="filter-tabs">{(["all","income","expense"] as const).map((filter) => <button type="button" key={filter} className={transactionFilter===filter? "active":""} onClick={() => setTransactionFilter(filter)}>{filter==="all"? "全部":filter==="income"? "收入":"支出"}<span>{filter==="all"? data.transactions.filter((item) => !item.deleted).length+data.transfers.filter((item) => !item.deleted).length:data.transactions.filter((item) => !item.deleted&&item.type===filter).length}</span></button>)}</div><section className="panel record-panel"><div className="record-head"><span aria-hidden="true" /><span>日期与分类</span><span>账户 / 说明</span><span>金额</span><span>操作</span></div>{records.length? records.map((record) => <div className="record-row" key={`${record.kind}-${record.id}`}><div className={`record-icon ${record.kind}`}><Receipt size={17} /></div><div><strong>{record.title}</strong><span>{formatDate(record.date)} · {record.kind==="transfer"? "转账":record.kind==="income"? "收入":"支出"}</span></div><div className="record-subtitle">{record.subtitle}</div><b className={record.kind==="income"? "positive":record.kind==="expense"? "negative":"transfer"}>{record.kind==="income"? "+":record.kind==="expense"? "-":"↔ "}{formatMoney(record.amount,record.currency)}</b><div className="record-actions"><button type="button" className="icon-button" aria-label={`编辑 ${record.title}`} onClick={() => record.kind==="transfer"? openTransfer(record.record):openTransaction(record.record)}><PencilSimple size={16} /></button><button type="button" className="icon-button danger-icon" aria-label={`删除 ${record.title}`} onClick={() => setDeleteTarget({ kind: record.kind==="transfer"? "transfer":"transaction",record: record.record })} title="删除"><Trash size={16} /></button><button type="button" className="icon-button" aria-label={`查看 ${record.title} 详情`} onClick={() => setRecordDetails({ kind: record.kind==="transfer"? "transfer":"transaction",id: record.id })}><FileText size={16} /></button></div></div>):<div className="empty-state"><ListChecks size={30} /><strong>还没有匹配记录</strong><span>从“记录收支”开始，所有记录都会绑定到对应账户。</span><button type="button" className="primary-button compact" onClick={openTransaction}>新增第一笔</button></div>}</section></main>;

  const renderBudgetLegacy=() => <main className="main-content module-page">{renderHeader("BUDGET","月度预算",{ label: "新增预算",onClick: () => openBudget(),icon: Plus })}<section className="budget-hero-grid"><div className="panel budget-free-panel"><div className="panel-kicker">本月可自由使用</div><strong>{formatMoney(freeToSpend,reportCurrency)}</strong><p>从流动余额开始，扣除本月每个预算的剩余额度，再扣除今天之后的固定付款。</p><div className="budget-formula"><span>流动余额<b>{formatMoney(liquidBalance,reportCurrency)}</b></span><span>预算剩余<b>- {formatMoney(budgetRemaining,reportCurrency)}</b></span><span>固定付款<b>- {formatMoney(upcomingTotal,reportCurrency)}</b></span></div></div><div className="panel budget-side-panel"><div className="panel-kicker">本月节奏</div><div className="budget-side-row"><span>已用预算</span><strong>{formatMoney(Math.max(0,monthlyBudgets.reduce((sum,budget) => sum+(convert(getBudgetSpent(data,budget),budget.currency,reportCurrency,data.fxRates)??0),0)),reportCurrency)}</strong></div><div className="budget-side-row"><span>收入 - 支出</span><strong>{formatMoney(monthlyIncome-monthlyExpenses,reportCurrency)}</strong></div><div className="budget-side-row"><span>本月记录</span><strong>{monthTransactions.length} 笔</strong></div></div></section><div className="module-toolbar"><div><div className="panel-kicker">{currentMonth} · MONTHLY PLAN</div><h2>分类预算</h2></div><p>预算只统计同月份、同分类的支出，并按手动汇率换算到报告币种。</p></div><section className="budget-list">{monthlyBudgets.length? monthlyBudgets.map((budget) => { const spent=getBudgetSpent(data,budget); const remaining=getBudgetRemaining(data,budget); const percent=Math.min(100,(budget.budgetAmount??budget.limit)? (spent/(budget.budgetAmount??budget.limit))*100:0); return <article className="panel budget-row" key={budget.id}><div className="budget-category"><div className="budget-dot" /><div><strong>{budget.category}</strong><span>{budget.currency} · {budget.month}</span></div></div><div className="budget-progress"><div><span style={{ width: `${percent}%` }} /></div><small>{formatMoney(spent,budget.currency)} / {formatMoney(budget.limit,budget.currency)}</small></div><div className={`budget-remaining ${remaining<=0? "danger":""}`}><span>剩余</span><strong>{formatMoney(remaining,budget.currency)}</strong></div><div className="inline-actions"><button type="button" className="text-button" onClick={() => openBudget(budget)}><PencilSimple size={15} /> 编辑</button><button type="button" className="text-button danger-text" aria-label={`停用预算 ${budget.category}`} onClick={() => archiveBudget(budget)} title="停用">停用</button><button type="button" className="text-button danger-text" aria-label={`删除预算 ${budget.category}`} onClick={() => deleteBudget(budget)} title="删除">删除</button></div></article>; }):<div className="empty-state panel"><ChartPieSlice size={30} /><strong>还没有本月预算</strong><span>添加一个分类限额，让可自由使用金额开始变得可解释。</span><button type="button" className="primary-button compact" onClick={() => setModal("budget")}>新增预算</button></div>}</section>{(data.budgets??[]).filter((budget) => (budget.active===false||budget.status==="inactive")&&(budget.period??budget.month)===currentMonth).length>0&&<section className="panel archived-records"><div className="panel-title-row"><div><div className="panel-kicker">BUDGET RECOVERY</div><h2>已停用预算</h2></div><Trash size={19} /></div>{(data.budgets??[]).filter((budget) => (budget.active===false||budget.status==="inactive")&&(budget.period??budget.month)===currentMonth).map((budget) => <div className="archived-row" key={budget.id}><div><strong>{budget.category}</strong><span>{formatMoney(budget.budgetAmount??budget.limit,budget.currency)} · {budget.period??budget.month}</span></div><button type="button" className="secondary-button compact" onClick={() => restoreBudget(budget)} title="恢复">恢复</button></div>)}</section>}{upcomingPayments.length>0&&<section className="panel commitments-panel"><div className="panel-title-row"><div><div className="panel-kicker">UPCOMING COMMITMENTS</div><h2>本月固定付款</h2></div><CalendarDots size={19} /></div>{upcomingPayments.map((payment) => <div className="commitment-row" key={payment.id}><div><strong>{payment.name}</strong><span>{payment.category} · {formatDate(payment.due)}</span></div><b>{formatMoney(payment.amount,payment.currency)}</b></div>)}</section>}</main>;

  const renderBudget=() => {
    const activeBudgets=(data.budgets??[]).filter((item) => (item.period??item.month)===currentMonth&&item.active!==false&&item.status!=="inactive"&&item.status!=="deleted"&&!item.deleted);
    const archivedBudgets=(data.budgets??[]).filter((item) => (item.period??item.month)===currentMonth&&(item.active===false||item.status==="inactive"||item.status==="deleted"||item.deleted));
    return <main className="main-content module-page">
      {renderHeader("BUDGET","月度预算",{ label: "新增预算",onClick: () => openBudget(),icon: Plus })}
      <section className="budget-hero-grid"><div className="panel budget-free-panel"><h2>本月可自由使用</h2><strong>{formatMoney(freeToSpend,reportCurrency)}</strong><p>预算、账户余额与固定付款均按现有多币种规则计算。</p></div><div className="panel budget-side-panel"><span>本月预算剩余</span><strong>{formatMoney(budgetRemaining,reportCurrency)}</strong><small>只统计同月、同分类、同币种预算。</small></div></section>
      <section className="budget-list">{activeBudgets.length? activeBudgets.map((budget) => { const spent=getBudgetSpent(data,budget); const remaining=getBudgetRemaining(data,budget); const percent=Math.min(100,(spent/(budget.budgetAmount??budget.limit))*100); return <article className="panel budget-row" key={budget.id}><div className="budget-category"><div className="budget-dot"/><div><strong>{budget.category}</strong><span>{budget.currency} · {budget.period??budget.month}</span></div></div><div className="budget-progress"><div><span style={{ width: `${percent}%` }}/></div><small>{formatMoney(spent,budget.currency)} / {formatMoney(budget.budgetAmount??budget.limit,budget.currency)}</small></div><div className="budget-remaining"><span>剩余</span><strong>{formatMoney(remaining,budget.currency)}</strong></div><div className="inline-actions"><button type="button" className="text-button" onClick={() => openBudget(budget)} title="编辑预算"><PencilSimple size={15}/>编辑</button><button type="button" className="text-button danger-text" onClick={() => archiveBudget(budget)} aria-label={`停用预算 ${budget.category}`} title="停用预算">停用</button><button type="button" className="text-button danger-text" onClick={() => deleteBudget(budget)} aria-label={`删除预算 ${budget.category}`} title="删除预算">删除</button></div></article>; }):<div className="panel empty-state"><ChartPieSlice size={30}/><strong>还没有本月预算</strong><button type="button" className="primary-button compact" onClick={() => openBudget()}>新增预算</button></div>}</section>
      <section className="panel archived-records"><div className="panel-title-row"><div><h2>已停用与已删除预算</h2><span>停用可恢复；永久删除不会影响交易记录、其他月份或其他币种。</span></div><ShieldCheck size={19}/></div>{archivedBudgets.length? archivedBudgets.map((budget) => <div className="archived-row" key={budget.id}><div><strong>{budget.category}</strong><span>{formatMoney(budget.budgetAmount??budget.limit,budget.currency)} · {budget.period??budget.month} · {budget.status==="deleted"||budget.deleted? "已删除":"已停用"}</span></div><div className="inline-actions"><button type="button" className="secondary-button compact" onClick={() => restoreBudget(budget)} aria-label={`恢复预算 ${budget.category}`} title="恢复预算">恢复</button><button type="button" className="icon-button danger-icon" onClick={() => requestEntityDelete({ kind: "budget",id: budget.id,action: "permanent" })} aria-label={`永久删除预算 ${budget.category}`} title="永久删除预算"><Trash size={16}/></button></div></div>):<div className="empty-state compact-empty"><ShieldCheck size={28}/><strong>没有停用或已删除预算</strong></div>}</section>
    </main>;
  };

  const renderGoalsLegacy=() => {
    const visibleGoals=data.goals.filter((goal) => goal.active!==false&&!goal.deleted&&(goalPeriodFilter==="all"||goal.cadence===goalPeriodFilter));
    const totalCurrent=data.goals.reduce((sum,goal) => sum+(convert(goal.current,goal.currency,reportCurrency,data.fxRates)??0),0);
    const totalTarget=data.goals.reduce((sum,goal) => sum+(convert(goal.target,goal.currency,reportCurrency,data.fxRates)??0),0);
    const totalGap=Math.max(0,totalTarget-totalCurrent);
    const totalProgress=totalTarget>0? Math.round((totalCurrent/totalTarget)*100):0;
    const plans=(data.annualPlans??[]).filter((plan) => plan.year===planYear).sort((a,b) => a.month-b.month);
    const planTotal=getAnnualPlanTotal(data,planYear,reportCurrency);
    const fundedPlanTotal=plans.filter((plan) => plan.status!=="planned").reduce((sum,plan) => sum+(convert(plan.amount,plan.currency,reportCurrency,data.fxRates)??0),0);
    const statusLabels={ "on-track": "进行中",watch: "需要关注",paused: "已暂停" };
    const planStatusLabels={ planned: "待准备",funded: "已预留",complete: "已完成" };
    const planGoalName=(goalId?: string) => data.goals.find((goal) => goal.id===goalId)?.name;

    return <main className="main-content module-page goals-page">{renderHeader("GOALS","储蓄目标与年度计划",{ label: "新增目标",onClick: () => openGoal(),icon: Plus })}<section className="goals-summary"><div><span>目标当前累计</span><strong>{formatMoney(totalCurrent,reportCurrency)}</strong><small>{data.goals.filter((goal) => goal.active!==false&&!goal.deleted).length} 个启用目标</small></div><div><span>目标总额</span><strong>{formatMoney(totalTarget,reportCurrency)}</strong><small>按当前手动汇率换算</small></div><div><span>待完成差额</span><strong>{formatMoney(totalGap,reportCurrency)}</strong><small>距离全部目标</small></div><div><span>整体进度</span><strong>{totalProgress}%</strong><small>当前 / 目标</small></div></section><section className="goals-workspace"><div className="panel goal-focus-panel"><div className="panel-title-row"><div><div className="panel-kicker">SAVINGS MAP</div><h2>目标周期与储蓄节奏</h2></div><Target size={21} className="sparkle" /></div><p className="module-intro">每个目标都会根据截止日期计算剩余月份，并显示下一周期需要准备的金额。</p><div className="period-tabs">{(["all","weekly","monthly","quarterly","yearly","custom","once"] as const).map((period) => <button type="button" key={period} className={goalPeriodFilter===period? "active":""} onClick={() => setGoalPeriodFilter(period)}>{period==="all"? "全部":period==="monthly"? "每月":period==="quarterly"? "每季度":period==="yearly"? "每年":period==="weekly"? "每周":period==="once"? "一次":"自定义"}</button>)}</div><div className="goal-list">{visibleGoals.length? visibleGoals.map((goal) => { const progress=getGoalProgress(goal); const gap=getGoalGap(goal); const months=getGoalMonthsRemaining(goal,today); const perMonth=getGoalRequiredPerMonth(goal,today); const perPeriod=getGoalRequiredPerPeriod(goal,today); return <article className="goal-card" key={goal.id}><div className="goal-card-top"><div><strong>{goal.name}</strong><span>{getGoalPeriodLabel(goal.cadence)} · 截止 {formatDate(goal.due)}</span></div><span className={`goal-status ${goal.status}`}>{statusLabels[goal.status]}</span></div><div className="goal-progress-row"><div className="goal-progress"><span style={{ width: `${progress}%` }} /></div><b>{Math.round(progress)}%</b></div><div className="goal-card-meta"><span>已存 <b>{formatMoney(goal.current,goal.currency)}</b></span><span>目标 <b>{formatMoney(goal.target,goal.currency)}</b></span><span>差额 <b>{formatMoney(gap,goal.currency)}</b></span></div><div className="goal-cycle"><div><span>剩余周期</span><strong>{months} 个月</strong></div><div><span>{goal.cadence==="quarterly"? "每季度建议":"每月建议"}</span><strong>{formatMoney(goal.cadence==="quarterly"? perPeriod:perMonth,goal.currency)}</strong></div></div><div className="inline-actions goal-actions"><button type="button" className="text-button" onClick={() => openGoal(goal)}><PencilSimple size={15} /> 编辑</button><button type="button" className="text-button danger-text" aria-label={`停用或删除目标 ${goal.name}`} onClick={() => archiveGoal(goal)} title="停用">停用/删除</button></div></article>; }):<div className="empty-state"><Target size={30} /><strong>没有匹配的目标周期</strong><span>切换周期筛选，或新增一个储蓄目标。</span><button type="button" className="primary-button compact" onClick={() => setModal("goal")}>新增目标</button></div>}</div></div><div className="panel annual-plan-panel"><div className="panel-title-row"><div><div className="panel-kicker">ANNUAL ROADMAP</div><h2>{planYear} 年度计划</h2></div><button type="button" className="secondary-button compact" onClick={() => setModal("annual-plan")}><Plus size={16} /> 新增计划</button></div><div className="year-switcher"><button type="button" className="icon-button" onClick={() => setPlanYear((year) => year-1)} aria-label="上一年">←</button><strong>{planYear}</strong><button type="button" className="icon-button" onClick={() => setPlanYear((year) => year+1)} aria-label="下一年">→</button></div><div className="annual-summary"><div><span>年度总额</span><b>{formatMoney(planTotal,reportCurrency)}</b></div><div><span>已预留</span><b>{formatMoney(fundedPlanTotal,reportCurrency)}</b></div></div><div className="annual-plan-list">{plans.length? plans.map((plan) => <div className="annual-plan-row" key={plan.id}><div className="annual-month">{String(plan.month).padStart(2,"0")}<small>月</small></div><div><strong>{plan.name}</strong><span>{plan.category}{planGoalName(plan.goalId)? ` · 关联 ${planGoalName(plan.goalId)}`:""}</span></div><div className={`plan-status ${plan.status}`}>{planStatusLabels[plan.status]}</div><b>{formatMoney(plan.amount,plan.currency)}</b></div>):<div className="empty-state"><CalendarDots size={28} /><strong>这一年还没有计划</strong><span>把大额支出或年度储蓄动作放到时间线上。</span><button type="button" className="secondary-button compact" onClick={() => setModal("annual-plan")}>新增年度计划</button></div>}</div></div><section className="panel archived-records"><div className="panel-title-row"><div><div className="panel-kicker">GOAL RECOVERY</div><h2>已停用目标周期</h2></div><Trash size={19} /></div>{data.goals.filter((goal) => goal.active===false||goal.deleted).length? data.goals.filter((goal) => goal.active===false||goal.deleted).map((goal) => <div className="archived-row" key={goal.id}><div><strong>{goal.name}</strong><span>{getGoalPeriodLabel(goal.cadence)} · 历史储蓄 {formatMoney(goal.current,goal.currency)}</span></div><button type="button" className="secondary-button compact" onClick={() => restoreGoal(goal)} title="恢复">恢复</button></div>):<span className="form-help">没有已停用的储蓄目标。</span>}</section></section></main>;
  };

  const renderGoals=() => {
    const visibleGoals=data.goals.filter((goal) => goal.active!==false&&!goal.deleted&&(goalPeriodFilter==="all"||goal.cadence===goalPeriodFilter));
    const archivedGoals=data.goals.filter((goal) => goal.active===false||goal.deleted);
    const plans=(data.annualPlans??[]).filter((plan) => plan.year===planYear&&plan.active!==false&&!plan.deleted).sort((a,b) => a.month-b.month);
    const archivedPlans=(data.annualPlans??[]).filter((plan) => plan.active===false||plan.deleted);
    const statusLabels={ "on-track": "进行中",watch: "需要关注",paused: "已暂停" };
    return <main className="main-content module-page goals-page">
      {renderHeader("GOALS","储蓄目标与年度计划",{ label: "新增目标",onClick: () => openGoal(),icon: Plus })}
      <section className="goals-workspace">
        <div className="panel goal-focus-panel">
          <div className="panel-title-row"><div><h2>目标周期与储蓄节奏</h2><span>停用只停止未来计划；删除会进入恢复区，均不改变历史储蓄记录。</span></div><Target size={21} className="sparkle" /></div>
          <div className="period-tabs">{(["all","weekly","monthly","quarterly","yearly","custom","once"] as const).map((period) => <button type="button" key={period} className={goalPeriodFilter===period? "active":""} onClick={() => setGoalPeriodFilter(period)}>{period==="all"? "全部":getGoalPeriodLabel(period)}</button>)}</div>
          <div className="goal-list">{visibleGoals.length? visibleGoals.map((goal) => <article className="goal-card" key={goal.id}>
            <div className="goal-card-top"><div><strong>{goal.name}</strong><span>{getGoalPeriodLabel(goal.cadence)} · 截止 {formatDate(goal.due)}</span></div><span className={`goal-status ${goal.status}`}>{statusLabels[goal.status]}</span></div>
            <div className="goal-progress-row"><div className="goal-progress"><span style={{ width: `${getGoalProgress(goal)}%` }} /></div><b>{Math.round(getGoalProgress(goal))}%</b></div>
            <div className="goal-card-meta"><span>已存 <b>{formatMoney(goal.current,goal.currency)}</b></span><span>目标 <b>{formatMoney(goal.target,goal.currency)}</b></span><span>差额 <b>{formatMoney(getGoalGap(goal),goal.currency)}</b></span></div>
            <div className="inline-actions goal-actions"><button type="button" className="text-button" onClick={() => openGoal(goal)} title="编辑目标"> <PencilSimple size={15} />编辑</button><button type="button" className="text-button danger-text" onClick={() => stopGoal(goal)} aria-label={`停用目标周期 ${goal.name}`} title="停用目标周期">停用</button><button type="button" className="text-button danger-text" onClick={() => deleteGoal(goal)} aria-label={`删除目标周期 ${goal.name}`} title="删除目标周期">删除</button></div>
          </article>):<div className="empty-state"><Target size={30}/><strong>没有匹配的目标周期</strong><span>可新增一个目标，或切换上方周期筛选。</span><button type="button" className="primary-button compact" onClick={() => openGoal()}>新增目标</button></div>}</div>
        </div>
        <div className="panel annual-plan-panel">
          <div className="panel-title-row"><div><h2>{planYear} 年度计划</h2><span>每条计划可单独编辑或删除，不会影响目标或交易。</span></div><button type="button" className="secondary-button compact" onClick={() => openAnnualPlan()}><Plus size={16}/>新增计划</button></div>
          <div className="year-switcher"><button type="button" className="icon-button" onClick={() => setPlanYear((year) => year-1)} aria-label="上一年" title="上一年">←</button><strong>{planYear}</strong><button type="button" className="icon-button" onClick={() => setPlanYear((year) => year+1)} aria-label="下一年" title="下一年">→</button></div>
          <div className="annual-plan-list">{plans.length? plans.map((plan) => <div className="annual-plan-row" key={plan.id}><div className="annual-month">{String(plan.month).padStart(2,"0")}<small>月</small></div><div><strong>{plan.name}</strong><span>{plan.category}</span></div><div className={`plan-status ${plan.status}`}>{plan.status==="planned"? "待准备":plan.status==="funded"? "已预留":"已完成"}</div><b>{formatMoney(plan.amount,plan.currency)}</b><div className="inline-actions"><button type="button" className="icon-button" onClick={() => openAnnualPlan(plan)} aria-label={`编辑年度计划 ${plan.name}`} title="编辑年度计划"><PencilSimple size={16}/></button><button type="button" className="text-button danger-text" onClick={() => requestEntityDelete({ kind: "annual-plan",id: plan.id,action: "deactivate" })} aria-label={`停用年度计划 ${plan.name}`} title="停用年度计划">停用</button><button type="button" className="icon-button danger-icon" onClick={() => requestEntityDelete({ kind: "annual-plan",id: plan.id,action: "delete" })} aria-label={`删除年度计划 ${plan.name}`} title="删除年度计划"><Trash size={16}/></button></div></div>):<div className="empty-state compact-empty"><CalendarDots size={28}/><strong>这一年还没有计划</strong><button type="button" className="secondary-button compact" onClick={() => openAnnualPlan()}>新增年度计划</button></div>}</div>
        </div>
        <section className="panel archived-records"><div className="panel-title-row"><div><h2>已停用目标周期</h2><span>恢复会重新启用周期；永久删除只会移除该目标资料。</span></div><ShieldCheck size={19}/></div>{archivedGoals.length? archivedGoals.map((goal) => <div className="archived-row" key={goal.id}><div><strong>{goal.name}</strong><span>{getGoalPeriodLabel(goal.cadence)} · 历史储蓄 {formatMoney(goal.current,goal.currency)}</span></div><div className="inline-actions"><button type="button" className="secondary-button compact" onClick={() => restoreGoal(goal)} aria-label={`恢复目标周期 ${goal.name}`} title="恢复目标周期">恢复</button><button type="button" className="icon-button danger-icon" onClick={() => requestEntityDelete({ kind: "goal",id: goal.id,action: "permanent" })} aria-label={`永久删除目标周期 ${goal.name}`} title="永久删除目标周期"><Trash size={16}/></button></div></div>):<div className="empty-state compact-empty"><ShieldCheck size={28}/><strong>没有已停用的储蓄目标</strong></div>}</section>
      </section>
      <section className="panel archived-records">
        <div className="panel-title-row"><div><h2>已停用与已删除年度计划</h2><span>恢复只重新启用该计划；永久删除不会改变目标、交易或固定付款。</span></div><ShieldCheck size={19}/></div>
        {archivedPlans.length? archivedPlans.map((plan) => <div className="archived-row" key={plan.id}><div><strong>{plan.name}</strong><span>{plan.year} 年 {plan.month} 月 · {formatMoney(plan.amount,plan.currency)} · {plan.deleted? "已删除":"已停用"}</span></div><div className="inline-actions"><button type="button" className="secondary-button compact" onClick={() => restoreAnnualPlan(plan)} aria-label={`恢复年度计划 ${plan.name}`} title="恢复年度计划">恢复</button><button type="button" className="icon-button danger-icon" onClick={() => requestEntityDelete({ kind: "annual-plan",id: plan.id,action: "permanent" })} aria-label={`永久删除年度计划 ${plan.name}`} title="永久删除年度计划"><Trash size={16}/></button></div></div>) : <div className="empty-state compact-empty"><ShieldCheck size={28}/><strong>没有已停用或已删除的年度计划</strong></div>}
      </section>
    </main>;
  };

  const renderAssets=() => {
    const activeAssets=data.assets.filter((asset) => !asset.deleted);
    const archivedAssets=data.assets.filter((asset) => asset.deleted);
    const categories=Array.from(new Set(activeAssets.map((asset) => asset.category)));
    const visibleAssets=activeAssets.filter((asset) => (assetCategoryFilter==="all"||asset.category===assetCategoryFilter)&&(assetStatusFilter==="all"||asset.status===assetStatusFilter));
    const totalCurrent=activeAssets.reduce((sum,asset) => sum+(convert(getAssetRealizedValue(asset),getAssetCurrentCurrency(asset),reportCurrency,data.fxRates)??0),0);
    const totalPurchase=activeAssets.reduce((sum,asset) => sum+(convert(asset.purchaseValue,getAssetPurchaseCurrency(asset),reportCurrency,data.fxRates)??0),0);
    const totalDailyCost=activeAssets.reduce((sum,asset) => sum+(convert(getAssetDailyCost(asset,today),getAssetCurrentCurrency(asset),reportCurrency,data.fxRates)??0),0);
    const totalUsageDays=activeAssets.reduce((sum,asset) => sum+getAssetUsageDays(asset,today),0);
    return <main className="main-content module-page assets-page">{renderHeader("ASSETS","物品资产",{ label: "新增资产",onClick: () => openAsset(),icon: Plus })}{migrationNotice&&<div className="asset-migration-notice" role="status"><ShieldCheck size={18} /><span>{migrationNotice}</span><button type="button" className="icon-button" aria-label="关闭迁移提示" onClick={() => setMigrationNotice(null)}><X size={15} /></button></div>}<section className="module-summary asset-summary"><div><span>当前物品价值</span><strong>{formatMoney(totalCurrent,reportCurrency)}</strong><small>{activeAssets.length} 项物品资产</small></div><div><span>累计买入价值</span><strong>{formatMoney(totalPurchase,reportCurrency)}</strong><small>保留每项原始买入货币</small></div><div><span>每日成本</span><strong>{formatMoney(totalDailyCost,reportCurrency)}</strong><small>按自动使用天数计算</small></div><div><span>已使用天数</span><strong>{totalUsageDays.toLocaleString()}</strong><small>跨资产累计</small></div></section><div className="module-toolbar asset-toolbar"><div><div className="panel-kicker">USE VALUE LEDGER</div><h2>买入、使用与当前价值</h2></div><p>日均成本只描述价值消耗，不会改动账户余额、交易或汇率快照。</p></div><div className="asset-filters"><select aria-label="按资产分类筛选" value={assetCategoryFilter} onChange={(event) => setAssetCategoryFilter(event.target.value)}><option value="all">全部分类</option>{categories.map((category) => <option key={category}>{category}</option>)}</select><select aria-label="按资产状态筛选" value={assetStatusFilter} onChange={(event) => setAssetStatusFilter(event.target.value as typeof assetStatusFilter)}><option value="all">全部状态</option><option value="active">使用中</option><option value="unused">闲置</option><option value="sold">已出售</option></select><span>{visibleAssets.length} / {activeAssets.length} 项</span></div><section className="asset-management-list">{visibleAssets.length? visibleAssets.map((asset) => { const currentValue=getAssetRealizedValue(asset); const valueChange=getAssetValueChange(asset); const dailyCost=getAssetDailyCost(asset,today); const usageDays=getAssetUsageDays(asset,today); const costPerUse=getAssetCostPerUse(asset,today); return <article className="panel asset-management-row" key={asset.id}><div className={`asset-visual ${asset.category==="黄金"? "gold":asset.category==="相机"? "camera":""}`}><Briefcase size={22} /></div><div className="asset-management-main"><div className="asset-row-heading"><div><strong>{asset.name}</strong><span>{asset.category} · {asset.status==="active"? "使用中":asset.status==="unused"? "闲置":"已出售"}</span></div><div className="asset-row-actions"><button type="button" className="icon-button" aria-label={`编辑 ${asset.name}`} onClick={() => openAsset(asset)}><PencilSimple size={16} /></button><button type="button" className="icon-button danger-icon" aria-label={`删除 ${asset.name}`} onClick={() => deleteAsset(asset)} disabled={Boolean(deleteInFlightKey)} title="删除"><Trash size={16} /></button></div></div><div className="asset-management-metrics"><div><span>买入</span><b>{formatMoney(asset.purchaseValue,getAssetPurchaseCurrency(asset))}</b><small>{asset.purchaseDate??"未填写"}</small></div><div><span>{asset.status==="sold"? "卖出":"当前价值"}</span><b>{formatMoney(currentValue,getAssetCurrentCurrency(asset))}</b><small className={valueChange>=0? "positive":"negative"}>{valueChange>=0? "+":""}{formatMoney(valueChange,getAssetCurrentCurrency(asset))}</small></div><div><span>日均成本</span><b>{usageDays>0? formatMoney(dailyCost,getAssetCurrentCurrency(asset)):"尚未计算"}</b><small>{asset.usageStartDate??asset.purchaseDate??"等待使用日期"} · {usageDays} 天{costPerUse===null? "":` · 单次 ${formatMoney(costPerUse,getAssetCurrentCurrency(asset))}`}</small></div></div>{asset.note&&<p>{asset.note}</p>}</div></article>; }):<div className="panel empty-state asset-empty"><Briefcase size={32} /><strong>还没有匹配的物品资产</strong><span>记录一件物品后，系统会计算日均成本和当前价值变化。</span><button type="button" className="primary-button compact" onClick={() => openAsset()}>新增第一项资产</button></div>}</section></main>;
  };

  const renderAssetRecovery=() => {
    const archivedAssets=data.assets.filter((asset) => asset.deleted);
    if(!archivedAssets.length) return null;
    return <section className="main-content module-page archived-assets-page"><section className="panel archived-records"><div className="panel-title-row"><div><h2>已删除物品资产</h2><span>恢复会重新计入资产价值；永久删除不会影响账户、交易、汇率或投资资料。</span></div><ShieldCheck size={19}/></div>{archivedAssets.map((asset) => <div className="archived-row" key={asset.id}><div><strong>{asset.name}</strong><span>{asset.category} · 买入 {formatMoney(asset.purchaseValue,getAssetPurchaseCurrency(asset))} · {asset.deletedAt?.slice(0,10)??"已删除"}</span></div><div className="inline-actions"><button type="button" className="secondary-button compact" onClick={() => { setData((current) => ({ ...current,assets: current.assets.map((item) => item.id===asset.id? { ...item,deleted: false,deletedAt: undefined }:item) })); showToast("物品资产已恢复"); }} aria-label={`恢复物品资产 ${asset.name}`} title="恢复物品资产">恢复</button><button type="button" className="icon-button danger-icon" onClick={() => requestEntityDelete({ kind: "asset",id: asset.id,action: "permanent" })} aria-label={`永久删除物品资产 ${asset.name}`} title="永久删除物品资产"><Trash size={16}/></button></div></div>)}</section></section>;
  };

  const renderTrash=() => {
    const deletedTransactions=data.transactions.filter((item) => item.deleted).sort((a,b) => (b.deletedAt??b.date).localeCompare(a.deletedAt??a.date));
    const deletedTransfers=data.transfers.filter((item) => item.deleted).sort((a,b) => (b.deletedAt??b.date).localeCompare(a.deletedAt??a.date));
    const totalDeleted=deletedTransactions.length+deletedTransfers.length;
    return <main className="main-content module-page trash-page">{renderHeader("TRASH","回收站",{ label: "返回收支记录",onClick: () => setActive("transactions"),icon: ArrowRight })}<div className="trash-notice"><ShieldCheck size={19} /><div><strong>已删除记录仍保留在本地</strong><span>软删除不会进入余额、预算、收入支出或汇率使用统计。恢复后会重新计入，永久删除前会再次确认。</span></div></div><section className="module-summary trash-summary"><div><span>待处理记录</span><strong>{totalDeleted}</strong><small>收入、支出与转账</small></div><div><span>可恢复</span><strong>{totalDeleted}</strong><small>本地 IndexedDB</small></div><div><span>永久删除</span><strong>需确认</strong><small>此操作无法恢复</small></div></section><section className="panel trash-list"><div className="panel-title-row"><div><div className="panel-kicker">LOCAL RECOVERY</div><h2>已删除记录</h2></div><Trash size={20} /></div>{totalDeleted===0? <div className="empty-state compact-empty"><ShieldCheck size={30} /><strong>回收站为空</strong><span>从收支记录删除的项目会在这里保留，方便恢复。</span></div>:<div className="deleted-record-list">{deletedTransactions.map((item) => <div className="deleted-record-row" key={`transaction-${item.id}`}><div><strong>{item.merchant||item.category}</strong><span>{item.date} · {item.type==="income"? "收入":"支出"} · {item.category}</span></div><div><b className={item.type==="income"? "positive":"negative"}>{item.type==="income"? "+":"-"}{formatMoney(item.amount,item.currency)}</b><small>{getAccount(data,item.accountId)?.name||"未关联账户"}</small></div><div className="record-actions"><button type="button" className="secondary-button compact" onClick={() => restoreRecord({ kind: "transaction",record: item })} title="恢复">恢复</button><button type="button" className="icon-button danger-icon" aria-label={`永久删除 ${item.merchant||item.category}`} onClick={() => setPermanentTarget({ kind: "transaction",record: item })} title="永久删除"><Trash size={16} /></button></div></div>)}{deletedTransfers.map((item) => <div className="deleted-record-row" key={`transfer-${item.id}`}><div><strong>{getAccount(data,item.fromAccountId)?.name||item.fromCurrency} → {getAccount(data,item.toAccountId)?.name||item.toCurrency}</strong><span>{item.date} · 转账 · 汇率 {item.rate.toFixed(4)}</span></div><div><b className="transfer">↔ {formatMoney(item.fromAmount,item.fromCurrency)}</b><small>{getAccount(data,item.fromAccountId)?.name||item.fromCurrency} → {getAccount(data,item.toAccountId)?.name||item.toCurrency}</small></div><div className="record-actions"><button type="button" className="secondary-button compact" onClick={() => restoreRecord({ kind: "transfer",record: item })} title="恢复">恢复</button><button type="button" className="icon-button danger-icon" aria-label="永久删除转账" onClick={() => setPermanentTarget({ kind: "transfer",record: item })} title="永久删除"><Trash size={16} /></button></div></div>)}</div>}</section></main>;
  };

  const renderSettings=() => assetMode? <>{renderAssets()}{renderAssetRecovery()}{assetModal&&<AssetEntryModal draft={assetDraft} setDraft={setAssetDraft} editing={Boolean(assetEditingId)} onClose={() => setAssetModal(false)} onSave={saveAsset} />}</>:fxMode? <FxCenter data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} />:<ObsidianWorkbench mode="settings" data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} />;
  const renderObsidian=() => <ObsidianWorkbench mode="sync" data={data} setData={setData} onToast={showToast} onNavigate={(page) => setActive(page)} />;
  const renderPlaceholder=() => <main className="main-content placeholder-page"><div className="page-header"><div><div className="breadcrumb">WEALTH ATLAS / MODULE</div><h1>{navItems.find((item) => item.key===active)?.label??"模块"}</h1></div></div><div className="panel empty-module"><Sparkle size={32} weight="fill" /><h2>这个模块保留在你的产品地图里</h2><p>本次版本先把账户、交易和预算闭环跑通，现有目标、资产、保险、报表和提醒结构仍然保留。</p><button type="button" className="primary-button" onClick={() => setActive("home")}>返回首页</button></div></main>;

  return <div className="app-shell"><div className="starfield" /><aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkle size={20} weight="fill" /></div><div><strong>我的财富星图</strong><span>WEALTH ATLAS</span></div></div><nav>{navItems.map(({ label,icon: Icon,key }) => <button type="button" key={key} className={active===key? "active":""} aria-current={active===key? "page":undefined} onClick={() => setActive(key)}><Icon size={20} weight={active===key? "fill":"regular"} /><span>{label}</span></button>)}</nav><div className="sidebar-bottom"><button type="button" className="side-action" onClick={openTransaction}><Plus size={18} weight="bold" /> 记一笔</button><button type="button" className="side-action secondary" onClick={() => openTransfer()}><ArrowsLeftRight size={18} /> 记转账</button><button type="button" className="side-action secondary" onClick={() => setActive("obsidian")}><ShieldCheck size={18} /> 同步 Obsidian</button><button type="button" className="side-action secondary" onClick={() => void exportExcel(data)}><FileXls size={18} /> 导出 Excel</button><button type="button" className="settings-button" onClick={() => setActive("settings")}><GearSix size={18} /> 设置</button></div></aside>{active==="home"? renderHome():active==="accounts"? renderAccounts():active==="transactions"? renderTransactions():active==="budget"? renderBudget():active==="goals"? renderGoals():active==="cashflow"? <AdvancedWorkbench page="cashflow" data={data} setData={setData} onToast={showToast} onNavigate={setActive} />:active==="watchlists"? <AdvancedWorkbench page="watchlists" data={data} setData={setData} onToast={showToast} onNavigate={setActive} />:active==="reports"? <AdvancedWorkbench page="reports" data={data} setData={setData} onToast={showToast} onNavigate={setActive} />:active==="insights"? <AdvancedWorkbench page="analysis" data={data} setData={setData} onToast={showToast} onNavigate={setActive} />:active==="insurance"? <AdvancedWorkbench page="integrations" data={data} setData={setData} onToast={showToast} onNavigate={setActive} />:active==="trash"? renderTrash():active==="obsidian"? renderObsidian():active==="assets"||active==="fx"||active==="settings"? renderSettings():renderPlaceholder()}{modal&&<EntryModal type={modal} onClose={() => { setModal(null); setTransactionEditingId(null); setTransferEditingId(null); setAccountEditingId(null); setBudgetEditingId(null); setGoalEditingId(null); }} onTransaction={addTransaction} onTransfer={addTransfer} onAccount={addAccount} onBudget={addBudget} onGoal={addGoal} onAnnualPlan={addAnnualPlan} onFx={saveFxRate} data={data} transactionDraft={transactionDraft} setTransactionDraft={setTransactionDraft} transferDraft={transferDraft} setTransferDraft={setTransferDraft} accountDraft={accountDraft} setAccountDraft={setAccountDraft} budgetDraft={budgetDraft} setBudgetDraft={setBudgetDraft} goalDraft={goalDraft} setGoalDraft={setGoalDraft} annualPlanDraft={annualPlanDraft} setAnnualPlanDraft={setAnnualPlanDraft} fxDraft={fxDraft} setFxDraft={setFxDraft} editingTransaction={Boolean(transactionEditingId)} editingTransfer={Boolean(transferEditingId)} editingAccount={Boolean(accountEditingId)} categories={transactionCategories} onOpenCategoryManager={() => setCategoryManagerOpen(true)} />}{recordDetails&&<RecordDetailsModal data={data} details={recordDetails} onClose={() => setRecordDetails(null)} />}{deleteTarget&&<DeleteConfirmModal target={deleteTarget} data={data} onCancel={() => setDeleteTarget(null)} onConfirm={softDeleteRecord} isProcessing={Boolean(deleteInFlightKey)} />}{permanentTarget&&<PermanentDeleteModal target={permanentTarget} data={data} onCancel={() => setPermanentTarget(null)} onConfirm={permanentlyDeleteRecord} isProcessing={Boolean(deleteInFlightKey)} />}{categoryManagerOpen&&<CategoryManagerModal onClose={() => setCategoryManagerOpen(false)} onSave={saveCategory} onEdit={(category) => { setCategoryEditingId(category.id||null); setCategoryDraft({ name: category.name,kind: category.kind,icon: category.icon??"",color: category.color??"#d7aa6f" }); }} onDeactivate={(category) => requestEntityDelete({ kind: "category",id: category.id,action: "deactivate" })} onPermanentDelete={(category) => requestEntityDelete({ kind: "category",id: category.id,action: "permanent" })} canPermanentlyDelete={(category) => Boolean(category.createdAt)&&!data.transactions.some((item) => item.categoryId===category.id)} onRestore={restoreCategory} categories={transactionCategories} draft={categoryDraft} setDraft={setCategoryDraft} editingId={categoryEditingId} />}{entityDeleteTarget&&<EntityDeleteConfirmModal target={entityDeleteTarget} data={data} onCancel={() => setEntityDeleteTarget(null)} onConfirm={confirmEntityDelete} isProcessing={Boolean(deleteInFlightKey)} />}{accountDeleteTarget&&<AccountArchiveConfirmModal account={accountDeleteTarget} data={data} onCancel={() => setAccountDeleteTarget(null)} onConfirm={confirmArchiveAccount} isProcessing={Boolean(deleteInFlightKey)} />}{toast&&<div className="toast"><Check size={17} weight="bold" /> <span>{toast}</span>{toastAction&&<button type="button" className="toast-action" onClick={() => { toastAction(); setToast(null); setToastAction(null); }}>{toastActionLabel}</button>}<button type="button" onClick={() => { setToast(null); setToastAction(null); }} aria-label="关闭提示"><X size={15} /></button></div>}</div>;
}

function AccountEntryModal({ onClose,onSave,data,draft,setDraft,editing }: { onClose: () => void; onSave: () => void; data: WealthData; draft: AccountDraft; setDraft: Dispatch<SetStateAction<AccountDraft>>; editing: boolean; }) {
  const parentAccounts=data.accounts.filter((account) => account.status!=="inactive"&&account.status!=="deleted");
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(event.currentTarget===event.target) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ACCOUNTS</div><h2 id="account-modal-title">{editing? "编辑账户":"新增账户"}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div><div className="form-stack"><label>账户名称<input autoFocus placeholder="例如：日常现金" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current,name: event.target.value }))} /></label><div className="form-grid"><label>账户分组<input placeholder="例如：现金管理" value={draft.accountGroup??""} onChange={(event) => setDraft((current) => ({ ...current,accountGroup: event.target.value }))} /></label><label>机构<input placeholder="例如：DBS / Maybank" value={draft.institution??""} onChange={(event) => setDraft((current) => ({ ...current,institution: event.target.value }))} /></label></div><div className="form-grid"><label>类型<select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current,type: event.target.value as Account["type"] }))}><option value="bank">银行账户</option><option value="cash">现金</option><option value="investment">投资账户</option><option value="credit-card">信用卡</option></select></label><label>币种<select value={draft.currency} onChange={(event) => setDraft((current) => ({ ...current,currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>父账户（可选）<select value={draft.parentAccountId??""} onChange={(event) => setDraft((current) => ({ ...current,parentAccountId: event.target.value }))}><option value="">无父账户</option>{parentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label><label>开户余额<input type="number" step="0.01" value={draft.balance} onChange={(event) => setDraft((current) => ({ ...current,balance: event.target.value }))} /></label><label className="checkbox-label"><input type="checkbox" checked={draft.includeInNetWorth!==false} onChange={(event) => setDraft((current) => ({ ...current,includeInNetWorth: event.target.checked }))} />计入净资产</label><p className="form-help">账户改名、分组和机构信息会同步到所有显示和导出；历史交易、转账与汇率快照不会被重写。</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={onSave}>保存账户</button></div></div></div></div>;
}

function CategoryManagerModal({ onClose,onSave,onEdit,onDeactivate,onPermanentDelete,canPermanentlyDelete,onRestore,categories,draft,setDraft,editingId }: { onClose: () => void; onSave: () => void; onEdit: (category: TransactionCategory) => void; onDeactivate: (category: TransactionCategory) => void; onPermanentDelete: (category: TransactionCategory) => void; canPermanentlyDelete: (category: TransactionCategory) => boolean; onRestore: (category: TransactionCategory) => void; categories: TransactionCategory[]; draft: { name: string; kind: TransactionCategory["kind"]; icon: string; color: string; }; setDraft: Dispatch<SetStateAction<{ name: string; kind: TransactionCategory["kind"]; icon: string; color: string; }>>; editingId: string|null; }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(event.currentTarget===event.target) onClose(); }}><div className="modal category-manager-modal" role="dialog" aria-modal="true" aria-labelledby="category-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / CATEGORIES</div><h2 id="category-modal-title">交易分类管理</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭分类管理" title="关闭"><X size={19} /></button></div><div className="form-stack"><label>分类名称<input autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current,name: event.target.value }))} placeholder="例如：宠物" /></label><div className="form-grid"><label>适用类型<select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current,kind: event.target.value as TransactionCategory["kind"] }))}><option value="expense">支出</option><option value="income">收入</option></select></label><label>颜色<input type="color" value={draft.color} onChange={(event) => setDraft((current) => ({ ...current,color: event.target.value }))} /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setDraft({ name: "",kind: "expense",icon: "",color: "#d7aa6f" }); onEdit({ id: "",name: "",kind: "expense" }); }}>清空</button><button type="button" className="primary-button" onClick={onSave}>{editingId? "保存分类":"新增分类"}</button></div></div><div className="category-manager-list">{categories.map((category) => <div className={"category-manager-row "+(category.active===false? "inactive":"")} key={category.id}><span className="category-color-dot" style={{ background: category.color }} /><div><strong>{category.name}</strong><span>{category.kind==="income"? "收入":"支出"} · {category.active===false? "已停用":"启用"}</span></div><div className="inline-actions"><button type="button" className="icon-button" onClick={() => onEdit(category)} aria-label={"编辑分类 "+category.name} title={"编辑分类 "+category.name}><PencilSimple size={15} /></button>{category.active===false ? <><button type="button" className="text-button" aria-label={"恢复分类 "+category.name} onClick={() => onRestore(category)} title={"恢复分类 "+category.name}>恢复</button>{canPermanentlyDelete(category)&&<button type="button" className="icon-button danger-icon" aria-label={"永久删除分类 "+category.name} onClick={() => onPermanentDelete(category)} title={"永久删除分类 "+category.name}><Trash size={15}/></button>}</> : <button type="button" className="text-button danger-text" aria-label={"停用分类 "+category.name} onClick={() => onDeactivate(category)} title={"停用分类 "+category.name}>停用</button>}</div></div>)}</div></div></div>;
}

function EntityDeleteConfirmModal({ target,data,onCancel,onConfirm,isProcessing }: { target: Exclude<EntityDeleteTarget,null>; data: WealthData; onCancel: () => void; onConfirm: () => void; isProcessing: boolean; }) {
  const category=target.kind==="category"? data.categories?.find((item) => item.id===target.id):undefined;
  const budget=target.kind==="budget"? data.budgets?.find((item) => item.id===target.id):undefined;
  const goal=target.kind==="goal"? data.goals.find((item) => item.id===target.id):undefined;
  const asset=target.kind==="asset"? data.assets.find((item) => item.id===target.id):undefined;
  const annualPlan=target.kind==="annual-plan"? data.annualPlans?.find((item) => item.id===target.id):undefined;
  if(!category&&!budget&&!goal&&!asset&&!annualPlan) return null;
  const title=category?.name??budget?.category??goal?.name??annualPlan?.name??asset?.name??"删除项目";
  const detail=budget? `${formatMoney(budget.budgetAmount??budget.limit,budget.currency)} · ${budget.period??budget.month}`:goal? `${formatMoney(goal.current,goal.currency)} / ${formatMoney(goal.target,goal.currency)} · 截止 ${goal.due}`:annualPlan? `${annualPlan.year} 年 ${annualPlan.month} 月 · ${formatMoney(annualPlan.amount,annualPlan.currency)}`:asset? `买入 ${formatMoney(asset.purchaseValue,asset.purchaseCurrency??asset.currency)}`:category?.kind==="income"? "收入分类":"支出分类";
  const isDeactivate=target.action==="deactivate";
  const isPermanent=target.action==="permanent";
  const warning=category? isPermanent? "永久删除只会移除这个未被引用的自定义分类；历史交易、账户和预算不会改变。":"该分类会停用，新记录不能再选择；历史交易和原始资料会保留。":budget&&isDeactivate? "预算会停用，历史预算和交易统计会保留。":budget&&isPermanent? "这会永久移除该预算，不会删除任何交易、分类或其他月份预算。":budget? "预算会移入恢复区，不会删除任何交易或分类。":goal&&isDeactivate? "目标周期会停止未来计划，历史储蓄记录会保留。":goal&&isPermanent? "这会永久移除该目标周期，不会删除目标历史金额、储蓄交易或其他目标。":goal? "目标会移入恢复区，历史储蓄记录会保留。":annualPlan&&isDeactivate? "年度计划会停止参与未来安排，并可在恢复区重新启用；目标、交易和固定付款都不会改变。":annualPlan&&isPermanent? "这会永久移除该年度计划；关联储蓄目标、交易记录和固定付款都不会改变。":annualPlan? "年度计划会移入恢复区，不会改变目标、交易或固定付款。":"物品资产会从资产列表移除，不会影响账户、交易、汇率或投资数据。";
  const confirmLabel=isPermanent? "永久删除":isDeactivate? "确认停用":"确认删除";
  const dialogTitle=isPermanent? "永久删除":isDeactivate? "确认停用":"确认删除";
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(!isProcessing&&event.currentTarget===event.target) onCancel(); }}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="entity-delete-title"><div className="modal-header"><div><div className="panel-kicker">RECOVERY ACTION</div><h2 id="entity-delete-title">{dialogTitle}</h2></div><button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label="关闭删除确认" title="关闭"><X size={19} /></button></div><p className="confirm-lead">{title}</p><div className="confirm-record-summary"><div><span>项目</span><strong>{detail}</strong></div><div><span>操作类型</span><strong>{isPermanent? "永久删除":isDeactivate? "停用并可恢复":"移入恢复区"}</strong></div></div><div className="confirm-warning"><ShieldCheck size={18} /><span>{warning}</span></div><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label={confirmLabel} title={confirmLabel}>{isProcessing? "处理中…":confirmLabel}</button></div></div></div>;
}

function EntryModal({ type,onClose,onTransaction,onTransfer,onAccount,onBudget,onGoal,onAnnualPlan,onFx,data,transactionDraft,setTransactionDraft,transferDraft,setTransferDraft,accountDraft,setAccountDraft,budgetDraft,setBudgetDraft,goalDraft,setGoalDraft,annualPlanDraft,setAnnualPlanDraft,fxDraft,setFxDraft,editingTransaction,editingTransfer,editingAccount,categories,onOpenCategoryManager }: { type: Exclude<ModalType,null>; onClose: () => void; onTransaction: () => void; onTransfer: () => void; onAccount: () => void; onBudget: () => void; onGoal: () => void; onAnnualPlan: () => void; onFx: () => void; data: WealthData; transactionDraft: TransactionDraft; setTransactionDraft: Dispatch<SetStateAction<TransactionDraft>>; transferDraft: TransferDraft; setTransferDraft: Dispatch<SetStateAction<TransferDraft>>; accountDraft: AccountDraft; setAccountDraft: Dispatch<SetStateAction<AccountDraft>>; budgetDraft: BudgetDraft; setBudgetDraft: Dispatch<SetStateAction<BudgetDraft>>; goalDraft: GoalDraft; setGoalDraft: Dispatch<SetStateAction<GoalDraft>>; annualPlanDraft: AnnualPlanDraft; setAnnualPlanDraft: Dispatch<SetStateAction<AnnualPlanDraft>>; fxDraft: { pair: string; rate: string; date: string; note: string; }; setFxDraft: Dispatch<SetStateAction<{ pair: string; rate: string; date: string; note: string; }>>; editingTransaction: boolean; editingTransfer: boolean; editingAccount: boolean; categories: TransactionCategory[]; onOpenCategoryManager: () => void; }) {
  const titles: Record<Exclude<ModalType,null>,string>={ transaction: "记录一笔收支",transfer: "记录账户转账",account: "新增账户",budget: "新增月度预算",goal: "新增储蓄目标","annual-plan": "新增年度计划",fx: "更新手动汇率" };
  const from=data.accounts.find((account) => account.id===transferDraft.fromAccountId);
  const to=data.accounts.find((account) => account.id===transferDraft.toAccountId);
  if(type==="account") return <AccountEntryModal onClose={onClose} onSave={onAccount} data={data} draft={accountDraft} setDraft={setAccountDraft} editing={editingAccount} />;
  if(type==="goal"||type==="annual-plan") return <GoalEntryModal type={type} onClose={onClose} onGoal={onGoal} onAnnualPlan={onAnnualPlan} data={data} goalDraft={goalDraft} setGoalDraft={setGoalDraft} annualPlanDraft={annualPlanDraft} setAnnualPlanDraft={setAnnualPlanDraft} />;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(event.currentTarget===event.target) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="entry-modal-title"><div className="modal-header"><div><div className="panel-kicker">WEALTH ATLAS / ACTION</div><h2 id="entry-modal-title">{titles[type]}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>{type==="transaction"&&<div className="form-stack"><div className="segmented"><button className={transactionDraft.type==="expense"? "selected":""} onClick={() => setTransactionDraft((draft) => ({ ...draft,type: "expense" }))}>支出</button><button className={transactionDraft.type==="income"? "selected":""} onClick={() => setTransactionDraft((draft) => ({ ...draft,type: "income" }))}>收入</button></div><label>关联账户<select value={transactionDraft.accountId} onChange={(event) => setTransactionDraft((draft) => ({ ...draft,accountId: event.target.value }))}>{data.accounts.filter((account) => account.status!=="inactive"&&account.status!=="deleted").map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label><label>金额<input type="number" min="0" step="0.01" placeholder="0.00" value={transactionDraft.amount} onChange={(event) => setTransactionDraft((draft) => ({ ...draft,amount: event.target.value }))} /></label><div className="form-grid"><label>分类<select value={transactionDraft.categoryId??""} onChange={(event) => { const category=categories.find((item) => item.id===event.target.value); setTransactionDraft((draft) => ({ ...draft,categoryId: category?.id,category: category?.name??"" })); }}><option value="">选择分类</option>{categories.filter((item) => item.kind===transactionDraft.type&&item.active!==false).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button type="button" className="text-button inline-form-action" onClick={onOpenCategoryManager}>+ 管理分类</button></label><label>日期<input type="date" value={transactionDraft.date} onChange={(event) => setTransactionDraft((draft) => ({ ...draft,date: event.target.value }))} /></label></div><label>商户或备注<input placeholder="例如：晚餐、Grab、软件订阅" value={transactionDraft.merchant} onChange={(event) => setTransactionDraft((draft) => ({ ...draft,merchant: event.target.value }))} /></label><button type="button" className="primary-button full" onClick={onTransaction}>保存收支</button></div>}{type==="transfer"&&<div className="form-stack"><div className="form-grid"><label>转出账户<select value={transferDraft.fromAccountId} onChange={(event) => setTransferDraft((draft) => ({ ...draft,fromAccountId: event.target.value }))}>{data.accounts.filter((account) => account.status!=="inactive"&&account.status!=="deleted").map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label><label>转入账户<select value={transferDraft.toAccountId} onChange={(event) => setTransferDraft((draft) => ({ ...draft,toAccountId: event.target.value }))}>{data.accounts.filter((account) => account.status!=="inactive"&&account.status!=="deleted").map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label></div><div className="transfer-pair"><span>{from?.currency||"SGD"}</span><ArrowsLeftRight size={18} /><span>{to?.currency||"MYR"}</span></div><label>转出金额<input type="number" min="0" step="0.01" placeholder="2,000" value={transferDraft.amount} onChange={(event) => setTransferDraft((draft) => ({ ...draft,amount: event.target.value }))} /></label><label>手动汇率（1 {from?.currency||"SGD"} = {to?.currency||"MYR"}）<input type="number" min="0" step="0.0001" value={transferDraft.rate} onChange={(event) => setTransferDraft((draft) => ({ ...draft,rate: event.target.value }))} /></label><label>手续费（{from?.currency||"SGD"}）<input type="number" min="0" step="0.01" value={transferDraft.fee} onChange={(event) => setTransferDraft((draft) => ({ ...draft,fee: event.target.value }))} /></label><label>日期<input type="date" value={transferDraft.date} onChange={(event) => setTransferDraft((draft) => ({ ...draft,date: event.target.value }))} /></label><div className="conversion-preview">预计到账 <strong>{to?.currency||"MYR"} {((Number(transferDraft.amount)||0)*(Number(transferDraft.rate)||0)).toLocaleString(undefined,{ maximumFractionDigits: 2 })}</strong></div><button type="button" className="primary-button full" onClick={onTransfer}>保存转账</button></div>}{type===("account" as typeof type)&&<div className="form-stack"><label>账户名称<input placeholder="例如：日常现金" value={accountDraft.name} onChange={(event) => setAccountDraft((draft) => ({ ...draft,name: event.target.value }))} /></label><div className="form-grid"><label>类型<select value={accountDraft.type} onChange={(event) => setAccountDraft((draft) => ({ ...draft,type: event.target.value as Account["type"] }))}><option value="bank">银行账户</option><option value="cash">现金</option><option value="investment">投资账户</option><option value="credit-card">信用卡</option></select></label><label>币种<select value={accountDraft.currency} onChange={(event) => setAccountDraft((draft) => ({ ...draft,currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>开户余额<input type="number" step="0.01" value={accountDraft.balance} onChange={(event) => setAccountDraft((draft) => ({ ...draft,balance: event.target.value }))} /></label><p className="form-help">以后新增的收支和转账可以直接选择这个账户，余额会自动联动。</p><button type="button" className="primary-button full" onClick={onAccount}>保存账户</button></div>}{type==="budget"&&<div className="form-stack"><div className="form-grid"><label>月份<input type="month" value={budgetDraft.month} onChange={(event) => setBudgetDraft((draft) => ({ ...draft,month: event.target.value }))} /></label><label>币种<select value={budgetDraft.currency} onChange={(event) => setBudgetDraft((draft) => ({ ...draft,currency: event.target.value as CurrencyCode }))}>{currencies.map((currency) => <option key={currency}>{currency}</option>)}</select></label></div><label>分类<select value={budgetDraft.categoryId??""} onChange={(event) => { const category=data.categories?.find((item) => item.id===event.target.value); setBudgetDraft((draft) => ({ ...draft,categoryId: category?.id,category: category?.name??"" })); }}><option value="">选择支出分类</option>{data.categories?.filter((item) => item.kind==="expense"&&item.active!==false).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select><button type="button" className="text-button inline-form-action" onClick={onOpenCategoryManager}>+ 管理分类</button></label><label>月度限额<input type="number" min="0" step="0.01" value={budgetDraft.limit} onChange={(event) => setBudgetDraft((draft) => ({ ...draft,limit: event.target.value }))} /></label><p className="form-help">同月份、同分类的支出会从限额中扣除，其他币种会按当前手动汇率换算。</p><button type="button" className="primary-button full" onClick={onBudget}>保存预算</button></div>}{type==="fx"&&<div className="form-stack"><div className="form-grid"><label>汇率方向<select value={fxDraft.pair} onChange={(event) => setFxDraft((draft) => ({ ...draft,pair: event.target.value }))}><option>SGD/MYR</option><option>USD/SGD</option></select></label><label>汇率<input type="number" min="0" step="0.0001" value={fxDraft.rate} onChange={(event) => setFxDraft((draft) => ({ ...draft,rate: event.target.value }))} /></label></div><label>生效日期<input type="date" value={fxDraft.date} onChange={(event) => setFxDraft((draft) => ({ ...draft,date: event.target.value }))} /></label><label>备注<input placeholder="例如：银行实际到账汇率" value={fxDraft.note} onChange={(event) => setFxDraft((draft) => ({ ...draft,note: event.target.value }))} /></label><button type="button" className="primary-button full" onClick={onFx}>保存手动汇率</button></div>}</div></div>;
}

function RecordDetailsModal({ data,details,onClose }: { data: WealthData; details: Exclude<RecordDetailState,null>; onClose: () => void; }) {
  const transaction=details.kind==="transaction"? data.transactions.find((item) => item.id===details.id):undefined;
  const transfer=details.kind==="transfer"? data.transfers.find((item) => item.id===details.id):undefined;
  if(!transaction&&!transfer) return null;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(event.currentTarget===event.target) onClose(); }}><div className="modal record-detail-modal" role="dialog" aria-modal="true" aria-labelledby="record-detail-title"><div className="modal-header"><div><div className="panel-kicker">RECORD DETAIL</div><h2 id="record-detail-title">{transaction? transaction.merchant||transaction.category:"账户转账"}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭详情"><X size={19} /></button></div>{transaction? <div className="detail-list"><div><span>交易日期</span><strong>{transaction.date}</strong></div><div><span>类型</span><strong>{transaction.type==="income"? "收入":"支出"}</strong></div><div><span>金额</span><strong>{formatMoney(transaction.amount,transaction.currency)}</strong></div><div><span>分类</span><strong>{transaction.category}</strong></div><div><span>账户</span><strong>{getAccount(data,transaction.accountId)?.name||"未关联账户"}</strong></div><div><span>汇率快照</span><strong>{transaction.fxSnapshot? `${transaction.fxSnapshot.rateDirection} ${transaction.fxSnapshot.rate}`:"未使用换算"}</strong></div>{transaction.note&&<div><span>备注</span><strong>{transaction.note}</strong></div>}</div>:transfer? <div className="detail-list"><div><span>交易日期</span><strong>{transfer.date}</strong></div><div><span>转出</span><strong>{getAccount(data,transfer.fromAccountId)?.name||transfer.fromCurrency} · {formatMoney(transfer.fromAmount,transfer.fromCurrency)}</strong></div><div><span>转入</span><strong>{getAccount(data,transfer.toAccountId)?.name||transfer.toCurrency} · {formatMoney(transfer.toAmount,transfer.toCurrency)}</strong></div><div><span>输入汇率</span><strong>{(transfer.inputRate??transfer.rate).toFixed(4)}</strong></div><div><span>实际汇率</span><strong>{(transfer.actualRate??transfer.rate).toFixed(4)}</strong></div><div><span>有效汇率</span><strong>{(transfer.effectiveRate??transfer.rate).toFixed(4)}</strong></div><div><span>手续费</span><strong>{formatMoney(transfer.fee,transfer.feeCurrency)}</strong></div></div>:null}<button type="button" className="primary-button full" onClick={onClose}>完成</button></div></div>;
}

function AccountArchiveConfirmModal({ account,data,onCancel,onConfirm,isProcessing }: { account: Account; data: WealthData; onCancel: () => void; onConfirm: () => void; isProcessing: boolean; }) {
  const transactionCount=data.transactions.filter((item) => item.accountId===account.id).length;
  const transferCount=data.transfers.filter((item) => item.fromAccountId===account.id||item.toAccountId===account.id).length;
  const hasHistory=transactionCount+transferCount>0;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if(!isProcessing&&event.currentTarget===event.target) onCancel(); }}><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="account-archive-title"><div className="modal-header"><div><div className="panel-kicker">ACCOUNT RECOVERY</div><h2 id="account-archive-title">{hasHistory? "停用账户":"移入回收站"}</h2></div><button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label="关闭账户操作确认" title="关闭"><X size={19} /></button></div><p className="confirm-lead">{account.name}</p><div className="confirm-record-summary"><div><span>关联收支</span><strong>{transactionCount} 笔</strong></div><div><span>关联转账</span><strong>{transferCount} 笔</strong></div><div><span>账户余额</span><strong>{formatMoney(account.balance,account.currency)}</strong></div><div><span>账户状态</span><strong>{hasHistory? "保留历史记录":"可恢复"}</strong></div></div><div className="confirm-warning"><ShieldCheck size={18} /><span>{hasHistory? "账户有历史记录，将停用并保留所有历史资料；以后仍可恢复。":"账户会移入回收站，历史资料不会被删除，之后可以恢复。"}</span></div><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label={hasHistory? "确认停用账户":"确认移入回收站"} title={hasHistory? "确认停用账户":"确认移入回收站"}>{hasHistory? "确认停用":"移入回收站"}</button></div></div></div>;
}

function DeleteConfirmModal({ target,data,onCancel,onConfirm,isProcessing }: { target: Exclude<DeleteTarget,null>; data: WealthData; onCancel: () => void; onConfirm: () => void; isProcessing: boolean; }) {
  const transaction=target.kind==="transaction"? target.record as Transaction:undefined;
  const transfer=target.kind==="transfer"? target.record as Transfer:undefined;
  const title=transaction? transaction.merchant||transaction.category:"账户转账";
  const amount=transaction? formatMoney(transaction.amount,transaction.currency):transfer? formatMoney(transfer.fromAmount,transfer.fromCurrency):"";
  const account=transaction? getAccount(data,transaction.accountId)?.name||"未关联账户":transfer? `${getAccount(data,transfer.fromAccountId)?.name||transfer.fromCurrency} → ${getAccount(data,transfer.toAccountId)?.name||transfer.toCurrency}`:"";
  return <div className="modal-backdrop" role="presentation"><div className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-record-title"><div className="modal-header"><div><div className="panel-kicker">MOVE TO TRASH</div><h2 id="delete-record-title">确认删除记录</h2></div><button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label="取消删除"><X size={19} /></button></div><p className="confirm-lead">这笔记录会先移入本地回收站，可以撤销或恢复。</p><div className="confirm-record-summary"><div><span>交易日期</span><strong>{transaction?.date??transfer?.date}</strong></div><div><span>金额</span><strong>{amount}</strong></div><div><span>分类</span><strong>{transaction?.category??"转账"}</strong></div><div><span>账户</span><strong>{account}</strong></div></div><div className="confirm-warning"><ShieldCheck size={18} /><span>删除后会影响账户余额、预算统计、收入支出汇总和转账汇率使用次数。原始资料不会立即永久删除。</span></div><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label="确认删除" title="确认删除">移入回收站</button></div></div></div>;
}

function PermanentDeleteModal({ target,data,onCancel,onConfirm,isProcessing }: { target: Exclude<DeleteTarget,null>; data: WealthData; onCancel: () => void; onConfirm: () => void; isProcessing: boolean; }) {
  const transaction=target.kind==="transaction"? target.record as Transaction:undefined;
  const transfer=target.kind==="transfer"? target.record as Transfer:undefined;
  const title=transaction? transaction.merchant||transaction.category:"账户转账";
  return <div className="modal-backdrop" role="presentation"><div className="modal confirm-modal danger-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title"><div className="modal-header"><div><div className="panel-kicker">PERMANENT DELETE</div><h2 id="permanent-delete-title">永久删除记录</h2></div><button type="button" className="icon-button" onClick={onCancel} disabled={isProcessing} aria-label="关闭永久删除确认" title="关闭"><X size={19} /></button></div><p className="confirm-lead">{title}</p><div className="confirm-warning danger-warning"><Trash size={18} /><span>此操作无法恢复，是否继续？永久删除后，这条本地回收站记录也会被移除。</span></div><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={isProcessing}>取消</button><button type="button" className="danger-button" onClick={onConfirm} disabled={isProcessing} aria-label="永久删除" title="永久删除">永久删除</button></div></div></div>;
}
