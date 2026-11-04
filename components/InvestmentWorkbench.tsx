"use client";
import { useEffect, useMemo, useRef } from "react";
import { createWorkbench } from "@/desktop/investment/workbench.cjs";
import { cashReserve } from "@/desktop/investment/ledger-model.cjs";
import { getDesktopBridge } from "@/lib/desktop";
import { assertActiveDataProfile, getDataProfile } from "@/lib/data-profile";
import { convert, getBudgetRemaining, getCashFlowForecast } from "@/lib/finance";
import type { WealthData } from "@/lib/types";

export default function InvestmentWorkbench({ data, onNavigate }: {data: WealthData; onNavigate: (page: string) => void}) {
  const target = useRef<HTMLDivElement>(null);
  const instance = useRef<ReturnType<typeof createWorkbench> | null>(null);
  const profileKey = getDataProfile().key;
  const context = useMemo(() => {
    const forecast = getCashFlowForecast(data, 30);
    const budgets = (data.budgets ?? []).filter(b => !b.deleted && b.active !== false && b.status !== "deleted" && b.status !== "inactive" && (b.period ?? b.month) >= forecast.fromDate.slice(0,7) && (b.period ?? b.month) <= forecast.toDate.slice(0,7));
    const planned = [...data.plannedPayments, ...(data.subscriptions ?? []).filter(s => s.active)];
    const budgetRows = budgets.map(b => {
      const category = b.category.trim().toLowerCase(), month = b.period ?? b.month;
      const covered = forecast.occurrences.filter(o => o.kind === "expense" && o.date.slice(0,7) === month && o.currency === b.currency && planned.find(p => o.id === p.id + "-" + o.date)?.category.trim().toLowerCase() === category).reduce((n,o) => n + o.amount, 0);
      return {key: month + "|" + category + "|" + b.currency, remaining: convert(getBudgetRemaining(data,b), b.currency, data.reportCurrency, data.fxRates), coveredPlanned: convert(covered, b.currency, data.reportCurrency, data.fxRates)};
    });
    const missingFx = data.accounts.some(a => convert(a.balance, a.currency, data.reportCurrency, data.fxRates) === null)
      || forecast.occurrences.some(p => convert(p.amount, p.currency, data.reportCurrency, data.fxRates) === null)
      || budgetRows.some(b => b.remaining === null || b.coveredPlanned === null)
      || convert(data.cashFlowSettings?.safetyBalance ?? 0, data.cashFlowSettings?.currency ?? data.reportCurrency, data.reportCurrency, data.fxRates) === null;
    const availability = missingFx ? null : cashReserve({endBalance: forecast.endBalance, safety: forecast.safetyBalance, budgets: budgetRows.map(b => ({key:b.key,remaining:b.remaining!,coveredPlanned:b.coveredPlanned!}))});
    return {
      holdings: (data.investments ?? []).map(i => ({name: i.name, account: data.accounts.find(a => a.id === i.accountId)?.name, currentValue: i.currentValue, currency: i.currency, asOf: i.valuationDate})),
      cashflow: data.accounts.length && availability ? {
        until: forecast.toDate, currency: forecast.currency, startBalance: forecast.startBalance,
        income: forecast.projectedIncome, expenses: forecast.projectedExpenses,
        reserves: forecast.plannedSavings + forecast.plannedInvestments, endBalance: forecast.endBalance,
        budgetReserve: availability.budgetReserve, safety: forecast.safetyBalance, available: availability.available,
        note: `已预留期间 ${budgets.length} 项已登记月预算的剩余额，扣除同月同分类、同币种的已预计账单，避免重复预留。跨月使用该月完整剩余额，估算较保守；未登记的未来预算仍需补齐。`,
      } : null,
    };
  }, [data]);
  const contextRef = useRef(context); contextRef.current = context;
  useEffect(() => {
    if (!target.current) return;
    const profile = getDataProfile(), bridge = getDesktopBridge();
    const ui = createWorkbench({context: contextRef.current,
      api: async (route, payload) => {
        assertActiveDataProfile(profile);
        if (!bridge?.investmentRequest) throw new Error("请使用已更新的 Wealth Atlas 桌面版，并在「同步 Obsidian」连接自己的 Vault。");
        const result = await bridge.investmentRequest(route, payload);
        assertActiveDataProfile(profile);
        if (!result.ok) { const error = Object.assign(new Error(result.error || "保存失败，输入仍保留"), {status: result.status}); throw error; }
        return result.value;
      },
      onResearch: async alias => {assertActiveDataProfile(profile); if (!bridge?.openInvestmentNote) throw new Error("请在桌面版连接 Obsidian 后打开关联笔记。"); await bridge.openInvestmentNote(alias);},
    });
    instance.current = ui; ui.mount(target.current);
    return () => { ui.destroy(); instance.current = null; };
  }, [profileKey]);
  useEffect(() => { instance.current?.updateContext(context); }, [context]);
  return <main className="main-content module-page"><div className="page-header module-header"><div><h1>我的投资</h1><p className="page-description">统一持仓、逐笔核对，也留住当时的判断。</p></div><button className="secondary-button" type="button" onClick={() => onNavigate("obsidian")}>连接或查看 Obsidian</button></div><section className="panel" style={{padding:22,minWidth:0}}><div ref={target} /></section></main>;
}
