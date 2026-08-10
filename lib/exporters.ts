import type { ObsidianTemplateKey, WealthData } from "./types";
import { convert, formatMoney, getAccountActivityCount, getAccountBalance, getAssetCostPerUse, getAssetCurrentCurrency, getAssetDailyCost, getAssetEndDate, getAssetPurchaseCurrency, getAssetRealizedValue, getAssetUsageDays, getAssetUsageStartDate, getBudgetRemaining, getCashFlowForecast, getGoalProgress, getRate, getRateAtDate, getUpcomingPlannedPayments, totalExpensesInCurrency, totalIncomeInCurrency, totalInCurrency } from "./finance";

const AUTO_START = "<!-- WEALTH_ATLAS_AUTO_START -->";
const AUTO_END = "<!-- WEALTH_ATLAS_AUTO_END -->";

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function downloadMarkdownFile(content: string, filename: string) {
  downloadBlob(new Blob([content], { type: "text/markdown;charset=utf-8" }), filename);
}

const defaultReview = `## 我的手写复盘\n\n这里是用户自己的内容。`;

export function getDefaultObsidianTemplates(): Record<ObsidianTemplateKey, string> {
  return {
    daily: `# {{date}}\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
    monthly: `# {{month}} 月度复盘\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
    yearly: `# {{year}} 年度复盘\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
    goal: `# 储蓄目标\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
    asset: `# 资产记录\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
    review: `# 财务复盘\n\n${AUTO_START}\n{{auto_content}}\n${AUTO_END}\n\n${defaultReview}`,
  };
}

function renderTemplate(key: ObsidianTemplateKey, data: WealthData, metadata: { type: string; period: string; title: string; date?: string; month?: string; year?: string }, body: string) {
  const template = data.obsidianTemplates?.[key] ?? getDefaultObsidianTemplates()[key];
  const rendered = template.replace(/\{\{date\}\}/g, metadata.date ?? "").replace(/\{\{month\}\}/g, metadata.month ?? "").replace(/\{\{year\}\}/g, metadata.year ?? "").replace(/\{\{auto_content\}\}/g, body);
  const withoutFrontmatter = rendered.replace(/^---[\s\S]*?---\s*/m, "").trim();
  const bodyWithRegion = withoutFrontmatter.includes(AUTO_START) && withoutFrontmatter.includes(AUTO_END)
    ? withoutFrontmatter.replace(/<!-- WEALTH_ATLAS_AUTO_START -->[\s\S]*?<!-- WEALTH_ATLAS_AUTO_END -->/, `${AUTO_START}\n${body}\n${AUTO_END}`)
    : `${AUTO_START}\n${body}\n${AUTO_END}\n\n${withoutFrontmatter}`;
  return `---\ntype: ${metadata.type}\n${metadata.period}\nreport_currency: ${data.reportCurrency}\nobsidian_source: wealth-atlas\n---\n\n${bodyWithRegion.trim()}\n`;
}

function localTransactions(data: WealthData, period: string) {
  return data.transactions.filter((item) => !item.deleted && item.date.startsWith(period));
}

function sumOriginal(data: WealthData, period: string, currency: "MYR" | "SGD" | "USD", type?: "income" | "expense") {
  return localTransactions(data, period).filter((item) => item.currency === currency && (!type || item.type === type)).reduce((sum, item) => sum + item.amount, 0);
}

function rateLine(data: WealthData) {
  return `- SGD/MYR：${getRate(data.fxRates, "SGD", "MYR")?.toFixed(4) ?? "未设置"}\n- USD/SGD：${getRate(data.fxRates, "USD", "SGD")?.toFixed(4) ?? "未设置"}`;
}

function reportTotals(data: WealthData, period: string) {
  const transactions = localTransactions(data, period);
  const scoped = { ...data, transactions };
  const income = totalIncomeInCurrency(scoped, data.reportCurrency);
  const expenses = totalExpensesInCurrency(scoped, data.reportCurrency);
  return { transactions, income, expenses, savings: income - expenses, rate: income > 0 ? ((income - expenses) / income) * 100 : 0 };
}

export function buildDailyMarkdown(data: WealthData, date = new Date().toISOString().slice(0, 10)) {
  const today = data.transactions.filter((item) => !item.deleted && item.date === date);
  const income = today.filter((item) => item.type === "income");
  const expenses = today.filter((item) => item.type === "expense");
  const transfers = data.transfers.filter((item) => !item.deleted && item.date === date);
  const budgetRemaining = (data.budgets ?? []).filter((budget) => budget.month === date.slice(0, 7)).reduce((sum, budget) => sum + getBudgetRemaining(data, budget), 0);
  const purchases = expenses.length ? expenses.map((item) => `- ${item.merchant || item.category}：${formatMoney(item.amount, item.currency)}${item.note ? `（${item.note}）` : ""}`).join("\n") : "- 暂无购买记录";
  const body = [
    `## 日期\n- ${date}`,
    `## 当日收入\n${income.length ? income.map((item) => `- ${item.category}：${formatMoney(item.amount, item.currency)}`).join("\n") : "- 暂无记录"}`,
    `## 当日支出\n${expenses.length ? expenses.map((item) => `- ${item.category}：${formatMoney(item.amount, item.currency)}`).join("\n") : "- 暂无记录"}`,
    `## 当日转账\n${transfers.length ? transfers.map((item) => `- ${item.fromCurrency} ${item.fromAmount.toLocaleString()} → ${item.toCurrency} ${item.toAmount.toLocaleString()}，汇率 ${item.rate}`).join("\n") : "- 暂无转账"}`,
    `## SGD/MYR 与 USD/SGD 汇率\n${rateLine(data)}`,
    `## 当日预算状态\n- 本月预算剩余：${formatMoney(budgetRemaining, data.reportCurrency)}`,
    `## 当日购买记录\n${purchases}`,
    `## 财务备注\n- 自动记录：${today.length} 笔交易，${transfers.length} 笔转账。`,
    `## 笔记链接\n- 对应月度笔记：[[${"财富理财师"}/02-每月/${date.slice(0, 4)}/${date.slice(0, 7)}|${date.slice(0, 7)} 月度复盘]]\n- 对应年度笔记：[[${"财富理财师"}/03-每年/${date.slice(0, 4)}|${date.slice(0, 4)} 年度复盘]]`,
  ].join("\n\n");
  return renderTemplate("daily", data, { type: "daily-finance", period: `date: ${date}`, title: date, date, month: date.slice(0, 7), year: date.slice(0, 4) }, body);
}

export function buildMonthlyMarkdown(data: WealthData, month = new Date().toISOString().slice(0, 7)) {
  const totals = reportTotals(data, month);
  const currencyRows = (["MYR", "SGD", "USD"] as const).map((currency) => `- ${currency}：收入 ${sumOriginal(data, month, currency, "income").toLocaleString()}，支出 ${sumOriginal(data, month, currency, "expense").toLocaleString()}`).join("\n");
  const sgdToMyr = convert(sumOriginal(data, month, "SGD"), "SGD", "MYR", data.fxRates) ?? 0;
  const usdToSgd = convert(sumOriginal(data, month, "USD"), "USD", "SGD", data.fxRates) ?? 0;
  const budgets = (data.budgets ?? []).filter((budget) => budget.month === month).map((budget) => `- ${budget.category}：预算 ${formatMoney(budget.limit, budget.currency)}，剩余 ${formatMoney(getBudgetRemaining(data, budget), budget.currency)}`).join("\n") || "- 本月没有预算";
  const watchlists = data.watchlists.map((item) => `- ${item.name}：${formatMoney(item.spent, item.currency)} / ${formatMoney(item.limit, item.currency)}，预测 ${formatMoney(item.forecast, item.currency)}`).join("\n") || "- 暂无 Watchlist";
  const goals = data.goals.map((goal) => `- ${goal.name}：${getGoalProgress(goal)}%，${formatMoney(goal.current, goal.currency)} / ${formatMoney(goal.target, goal.currency)}`).join("\n") || "- 暂无储蓄目标";
  const future = getUpcomingPlannedPayments(data, month, `${month}-01`).map((item) => `- ${item.due} ${item.name}：${formatMoney(item.amount, item.currency)}`).join("\n") || "- 本月没有未来固定付款";
  const body = [
    `## 月度收入\n- ${formatMoney(totals.income, data.reportCurrency)}`,
    `## 月度支出\n- ${formatMoney(totals.expenses, data.reportCurrency)}`,
    `## 月度储蓄\n- ${formatMoney(totals.savings, data.reportCurrency)}，储蓄率 ${totals.rate.toFixed(1)}%`,
    `## 多币种统计\n${currencyRows}`,
    `## 汇总换算\n- SGD 转 MYR：${sgdToMyr.toLocaleString()} MYR\n- USD 投资换算为 SGD：${usdToSgd.toLocaleString()} SGD`,
    `## 使用过的汇率\n${rateLine(data)}`,
    `## 预算与实际差异\n${budgets}`,
    `## Watchlist 结果\n${watchlists}`,
    `## 储蓄目标进度\n${goals}`,
    `## 未来现金流预测\n${future}`,
    `## 笔记链接\n- 对应年度笔记：[[${"财富理财师"}/03-每年/${month.slice(0, 4)}|${month.slice(0, 4)} 年度复盘]]\n- 对应每日笔记：[[${"财富理财师"}/01-每日/${month.slice(0, 4)}/${month}-01|${month}-01]]`,
    `## 月度复盘\n- 本月做得好的地方：\n- 下月需要调整的地方：\n- 下月第一个资金动作：`,
  ].join("\n\n");
  return renderTemplate("monthly", data, { type: "monthly-finance", period: `month: ${month}`, title: month, month, year: month.slice(0, 4) }, body);
}

export function buildYearlyMarkdown(data: WealthData, year = new Date().getFullYear()) {
  const period = String(year);
  const totals = reportTotals(data, period);
  const currencyRows = (["MYR", "SGD", "USD"] as const).map((currency) => `- ${currency}：收入 ${sumOriginal(data, period, currency, "income").toLocaleString()}，支出 ${sumOriginal(data, period, currency, "expense").toLocaleString()}`).join("\n");
  const monthlyLinks = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`).map((month) => `- [[${"财富理财师"}/02-每月/${year}/${month}|${month}]]`).join("\n");
  const investments = data.accounts.filter((account) => account.type === "investment").map((account) => `- ${account.name}：${formatMoney(account.balance, account.currency)}，换算 ${formatMoney(convert(account.balance, account.currency, "SGD", data.fxRates) ?? 0, "SGD")}`).join("\n") || "- 暂无投资账户";
  const assets = data.assets.map((asset) => `- ${asset.name}：当前价值 ${formatMoney(asset.currentValue, asset.currency)}，状态 ${asset.status}`).join("\n") || "- 暂无物品资产";
  const subscriptions = data.plannedPayments.map((item) => `- ${item.name}：${formatMoney(item.amount, item.currency)}，${item.cadence}`).join("\n") || "- 暂无订阅与年度支出";
  const goals = data.goals.map((goal) => `- ${goal.name}：${getGoalProgress(goal)}%，截止 ${goal.due}`).join("\n") || "- 暂无储蓄目标";
  const netAssets = totalInCurrency(data, data.reportCurrency) + data.assets.reduce((sum, asset) => sum + (convert(asset.currentValue, asset.currency, data.reportCurrency, data.fxRates) ?? 0), 0);
  const body = [
    `## 全年收入\n- ${formatMoney(totals.income, data.reportCurrency)}`,
    `## 全年支出\n- ${formatMoney(totals.expenses, data.reportCurrency)}`,
    `## 全年储蓄\n- ${formatMoney(totals.savings, data.reportCurrency)}，储蓄率 ${totals.rate.toFixed(1)}%`,
    `## 多币种资金变化\n${currencyRows}`,
    `## 汇率变化\n${rateLine(data)}`,
    `## 净资产变化\n- 当前净资产快照：${formatMoney(netAssets, data.reportCurrency)}\n- 本年度可见现金流变化：${formatMoney(totals.savings, data.reportCurrency)}`,
    `## 投资变化\n${investments}`,
    `## 资产负债复盘\n- 账户净值：${formatMoney(totalInCurrency(data, data.reportCurrency), data.reportCurrency)}\n- 物品资产：${formatMoney(data.assets.reduce((sum, asset) => sum + (convert(asset.currentValue, asset.currency, data.reportCurrency, data.fxRates) ?? 0), 0), data.reportCurrency)}`,
    `## 物品资产复盘\n${assets}`,
    `## 订阅复盘\n${subscriptions}`,
    `## 储蓄目标完成情况\n${goals}`,
    `## 下一年度计划\n- 最大的一笔年度支出：\n- 下一年度要先建立的缓冲：\n- 下一年度第一个储蓄动作：`,
    `## 年度链接\n${monthlyLinks}`,
    `## 年度复盘\n- 全年最大收获：\n- 全年最大的资金泄漏：\n- 明年需要保护的选择：`,
  ].join("\n\n");
  return renderTemplate("yearly", data, { type: "yearly-finance", period: `year: ${year}`, title: String(year), year: String(year) }, body);
}

export function buildAssetMarkdown(data: WealthData, assetId: string) {
  const asset = data.assets.find((item) => item.id === assetId);
  if (!asset) return "";
  const purchaseCurrency = getAssetPurchaseCurrency(asset);
  const currentCurrency = getAssetCurrentCurrency(asset);
  const startDate = getAssetUsageStartDate(asset);
  const usageDays = getAssetUsageDays(asset);
  const dailyCost = getAssetDailyCost(asset);
  const costPerUse = getAssetCostPerUse(asset);
  const usageMode = asset.usageStartMode === "customDate" ? "从自定义日期开始" : "从买入日期开始";
  const body = [
    `## 资产资料\n- 名称：${asset.name}\n- 分类：${asset.category}\n- 状态：${asset.status}\n- 买入价格：${formatMoney(asset.purchaseValue, purchaseCurrency)}\n- 买入日期：${asset.purchaseDate ?? "未填写"}\n- 当前价值：${formatMoney(getAssetRealizedValue(asset), currentCurrency)}`,
    `## 使用价值\n- 使用天数起算方式：${usageMode}\n- 使用起算日期：${startDate ?? "等待使用日期"}\n- 结束日期：${getAssetEndDate(asset)}\n- 当前使用天数：${usageDays} 天\n- 当前日均成本：${usageDays > 0 ? formatMoney(dailyCost, currentCurrency) : "尚未计算"}\n- 单次使用成本：${costPerUse === null ? "尚未设置使用次数" : formatMoney(costPerUse, currentCurrency)}`,
    `## 备注\n${asset.note || "- 暂无备注"}`,
  ].join("\n\n");
  return renderTemplate("asset", data, { type: "asset", period: `asset_id: ${asset.id}`, title: asset.name }, body);
}

export async function exportExcel(data: WealthData) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Wealth Atlas";
  const transactions = workbook.addWorksheet("Transactions");
  transactions.columns = [
    { header: "Date", key: "date", width: 14 }, { header: "Type", key: "type", width: 12 }, { header: "Category", key: "category", width: 20 }, { header: "Amount", key: "amount", width: 14 }, { header: "Currency", key: "currency", width: 12 }, { header: "Merchant", key: "merchant", width: 22 }, { header: "Note", key: "note", width: 30 }, { header: "Converted Amount", key: "convertedAmount", width: 18 }, { header: "Converted Currency", key: "convertedCurrency", width: 18 }, { header: "FX Rate", key: "fxRate", width: 12 }, { header: "FX Direction", key: "fxDirection", width: 16 }, { header: "FX Date", key: "fxDate", width: 14 }, { header: "FX Source", key: "fxSource", width: 18 }, { header: "FX Fee", key: "fxFee", width: 12 }, { header: "FX Effective Rate", key: "fxEffectiveRate", width: 18 },
  ];
  data.transactions.forEach((item) => transactions.addRow({ ...item, convertedAmount: item.fxSnapshot?.convertedAmount ?? item.convertedAmount, convertedCurrency: item.fxSnapshot?.convertedCurrency ?? item.convertedCurrency, fxRate: item.fxSnapshot?.rate ?? item.fxRate, fxDirection: item.fxSnapshot?.rateDirection, fxDate: item.fxSnapshot?.rateDate, fxSource: item.fxSnapshot?.rateSource, fxFee: item.fxSnapshot?.fee, fxEffectiveRate: item.fxSnapshot?.effectiveRate }));
  const transfers = workbook.addWorksheet("Transfers");
  transfers.columns = [{ header: "Date", key: "date", width: 14 }, { header: "From", key: "fromCurrency", width: 12 }, { header: "From Amount", key: "fromAmount", width: 16 }, { header: "To", key: "toCurrency", width: 12 }, { header: "To Amount", key: "toAmount", width: 16 }, { header: "Rate", key: "rate", width: 14 }, { header: "Input Rate", key: "inputRate", width: 14 }, { header: "Actual Rate", key: "actualRate", width: 14 }, { header: "Effective Rate", key: "effectiveRate", width: 16 }, { header: "Fee", key: "fee", width: 12 }, { header: "Fee Currency", key: "feeCurrency", width: 14 }, { header: "Rate Date", key: "rateDate", width: 14 }, { header: "Rate Source", key: "rateSource", width: 18 }];
  data.transfers.forEach((item) => transfers.addRow(item));
  const goals = workbook.addWorksheet("Goals");
  goals.columns = [{ header: "Goal", key: "name", width: 24 }, { header: "Current", key: "current", width: 16 }, { header: "Target", key: "target", width: 16 }, { header: "Currency", key: "currency", width: 12 }, { header: "Progress", key: "percent", width: 12 }, { header: "Due", key: "due", width: 14 }];
  data.goals.forEach((item) => goals.addRow(item));
  const annualPlans = workbook.addWorksheet("Annual Plans");
  annualPlans.columns = [{ header: "Year", key: "year", width: 10 }, { header: "Month", key: "month", width: 10 }, { header: "Plan", key: "name", width: 24 }, { header: "Category", key: "category", width: 18 }, { header: "Amount", key: "amount", width: 14 }, { header: "Currency", key: "currency", width: 12 }, { header: "Status", key: "status", width: 14 }, { header: "Note", key: "note", width: 30 }];
  (data.annualPlans ?? []).forEach((item) => annualPlans.addRow(item));
  const assets = workbook.addWorksheet("Asset Items");
  assets.columns = [{ header: "Name", key: "name", width: 24 }, { header: "Category", key: "category", width: 18 }, { header: "Purchase Value", key: "purchaseValue", width: 16 }, { header: "Purchase Currency", key: "purchaseCurrency", width: 18 }, { header: "Purchase Date", key: "purchaseDate", width: 16 }, { header: "Current Value", key: "currentValue", width: 16 }, { header: "Current Currency", key: "currentCurrency", width: 18 }, { header: "Sell Price", key: "sellPrice", width: 14 }, { header: "Sale Date", key: "saleDate", width: 14 }, { header: "Usage Start Mode", key: "usageStartMode", width: 18 }, { header: "Usage Start Date", key: "usageStartDate", width: 18 }, { header: "Usage End Date", key: "usageEndDate", width: 16 }, { header: "Calculated Usage Days", key: "calculatedUsageDays", width: 22 }, { header: "Daily Cost", key: "dailyCost", width: 14 }, { header: "Cost Per Use", key: "costPerUse", width: 14 }, { header: "Status", key: "status", width: 14 }, { header: "Note", key: "note", width: 30 }];
  data.assets.forEach((item) => assets.addRow({ ...item, purchaseCurrency: getAssetPurchaseCurrency(item), currentCurrency: getAssetCurrentCurrency(item), usageStartMode: item.usageStartMode ?? "purchaseDate", usageStartDate: getAssetUsageStartDate(item), usageEndDate: getAssetEndDate(item), calculatedUsageDays: getAssetUsageDays(item), dailyCost: getAssetDailyCost(item), costPerUse: getAssetCostPerUse(item) ?? "" }));
  const fx = workbook.addWorksheet("FX Rates");
  fx.columns = [{ header: "Base Currency", key: "baseCurrency", width: 16 }, { header: "Target Currency", key: "quoteCurrency", width: 16 }, { header: "Pair", key: "pair", width: 16 }, { header: "Rate", key: "rate", width: 16 }, { header: "Effective Date", key: "date", width: 18 }, { header: "Entered At", key: "enteredAt", width: 26 }, { header: "Source", key: "source", width: 18 }, { header: "Default", key: "isDefault", width: 12 }, { header: "Active", key: "active", width: 12 }, { header: "Use Count", key: "useCount", width: 12 }, { header: "Note", key: "note", width: 30 }];
  data.fxRates.forEach((item) => fx.addRow({ ...item, pair: `${item.baseCurrency}/${item.quoteCurrency}`, date: item.effectiveDate, note: item.note }));
  const addExportSheet = (name: string, columns: Array<{ header: string; key: string; width: number }>, rows: Array<unknown>) => {
    const sheet = workbook.addWorksheet(name);
    sheet.columns = columns;
    rows.forEach((row) => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFEAF6FF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D2A3D" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  };
  addExportSheet("Accounts", [{ header: "ID", key: "id", width: 24 }, { header: "Name", key: "name", width: 24 }, { header: "Type", key: "type", width: 16 }, { header: "Group", key: "accountGroup", width: 18 }, { header: "Institution", key: "institution", width: 20 }, { header: "Parent Account ID", key: "parentAccountId", width: 24 }, { header: "Currency", key: "currency", width: 14 }, { header: "Opening Balance", key: "openingBalance", width: 18 }, { header: "Current Balance", key: "currentBalance", width: 18 }, { header: "Activity Count", key: "activityCount", width: 16 }, { header: "Include In Net Worth", key: "includeInNetWorth", width: 20 }, { header: "Status", key: "status", width: 14 }], data.accounts.map((item) => ({ ...item, openingBalance: item.balance, currentBalance: getAccountBalance(data, item.id), activityCount: getAccountActivityCount(data, item.id) })));
  addExportSheet("Monthly Summary", [{ header: "Month", key: "month", width: 14 }, { header: "Income", key: "income", width: 16 }, { header: "Expenses", key: "expenses", width: 16 }, { header: "Savings", key: "savings", width: 16 }, { header: "Savings Rate", key: "savingsRate", width: 16 }], Array.from({ length: 12 }, (_, index) => {
    const month = `${new Date().getFullYear()}-${String(index + 1).padStart(2, "0")}`;
    const totals = reportTotals(data, month);
    return { month, income: totals.income, expenses: totals.expenses, savings: totals.savings, savingsRate: totals.rate };
  }));
  addExportSheet("Annual Summary", [{ header: "Year", key: "year", width: 12 }, { header: "Income", key: "income", width: 18 }, { header: "Expenses", key: "expenses", width: 18 }, { header: "Savings", key: "savings", width: 18 }, { header: "Savings Rate", key: "savingsRate", width: 16 }], [String(new Date().getFullYear()), ...Array.from(new Set(data.transactions.map((item) => item.date.slice(0, 4)))).filter((year) => year !== String(new Date().getFullYear()))].sort().map((year) => {
    const totals = reportTotals(data, year);
    return { year, income: totals.income, expenses: totals.expenses, savings: totals.savings, savingsRate: totals.rate };
  }));
  addExportSheet("Investments", [{ header: "ID", key: "id", width: 24 }, { header: "Name", key: "name", width: 24 }, { header: "Currency", key: "currency", width: 14 }, { header: "Value", key: "value", width: 16 }, { header: "Valuation Date", key: "valuationDate", width: 18 }, { header: "Account ID", key: "accountId", width: 24 }], data.investments ?? []);
  addExportSheet("Investment Transactions", [{ header: "ID", key: "id", width: 24 }, { header: "Investment ID", key: "investmentId", width: 24 }, { header: "Date", key: "date", width: 14 }, { header: "Type", key: "type", width: 14 }, { header: "Amount", key: "amount", width: 16 }, { header: "Currency", key: "currency", width: 14 }, { header: "Fee", key: "fee", width: 14 }], data.investmentTransactions ?? []);
  addExportSheet("Liabilities", [{ header: "ID", key: "id", width: 24 }, { header: "Name", key: "name", width: 24 }, { header: "Currency", key: "currency", width: 14 }, { header: "Principal", key: "principal", width: 16 }, { header: "Remaining", key: "remaining", width: 16 }, { header: "Interest Rate", key: "interestRate", width: 16 }, { header: "Minimum Payment", key: "minimumPayment", width: 18 }, { header: "Due Date", key: "dueDate", width: 16 }], data.liabilities ?? []);
  addExportSheet("Net Worth History", [{ header: "Date", key: "date", width: 16 }, { header: "Value", key: "value", width: 18 }, { header: "Currency", key: "currency", width: 14 }, { header: "Cash", key: "cash", width: 16 }, { header: "Investments", key: "investments", width: 18 }, { header: "Assets", key: "assets", width: 16 }, { header: "Liabilities", key: "liabilities", width: 18 }], data.netWorthHistory ?? []);
  addExportSheet("Subscriptions", [{ header: "ID", key: "id", width: 24 }, { header: "Name", key: "name", width: 24 }, { header: "Amount", key: "amount", width: 16 }, { header: "Currency", key: "currency", width: 14 }, { header: "Cadence", key: "cadence", width: 14 }, { header: "Next Date", key: "nextDate", width: 16 }, { header: "Active", key: "active", width: 12 }], data.subscriptions ?? []);
  addExportSheet("Watchlists", [{ header: "ID", key: "id", width: 24 }, { header: "Name", key: "name", width: 24 }, { header: "Currency", key: "currency", width: 14 }, { header: "Budget", key: "limit", width: 16 }, { header: "Warning Amount", key: "warningAmount", width: 18 }, { header: "Spent", key: "spent", width: 16 }, { header: "Average", key: "average", width: 16 }, { header: "Forecast", key: "forecast", width: 16 }, { header: "Category", key: "category", width: 18 }, { header: "Merchant", key: "merchant", width: 20 }], data.watchlists);
  const forecast = getCashFlowForecast(data, 90);
  addExportSheet("Cash Flow Forecast", [{ header: "Horizon", key: "horizon", width: 14 }, { header: "Start Balance", key: "startBalance", width: 18 }, { header: "Projected Income", key: "projectedIncome", width: 18 }, { header: "Projected Expenses", key: "projectedExpenses", width: 20 }, { header: "Projected Savings", key: "projectedSavings", width: 20 }, { header: "Projected Investments", key: "projectedInvestments", width: 22 }, { header: "End Balance", key: "endBalance", width: 18 }, { header: "Safety Balance", key: "safetyBalance", width: 18 }, { header: "Free To Spend", key: "freeToSpend", width: 18 }], [7, 30, 60, 90].map((horizon) => {
    const item = horizon === 90 ? forecast : getCashFlowForecast(data, horizon);
    return { horizon: `${horizon} days`, startBalance: item.startBalance, projectedIncome: item.projectedIncome, projectedExpenses: item.projectedExpenses, projectedSavings: item.plannedSavings, projectedInvestments: item.plannedInvestments, endBalance: item.endBalance, safetyBalance: item.safetyBalance, freeToSpend: item.freeToSpend };
  }));
  addExportSheet("Settings", [{ header: "Key", key: "key", width: 28 }, { header: "Value", key: "value", width: 42 }], [
    { key: "Report Currency", value: data.reportCurrency }, { key: "Schema Version", value: data.schemaVersion ?? "legacy" }, { key: "Cash Flow Safety Balance", value: data.cashFlowSettings?.safetyBalance ?? 0 },
  ]);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer]), `wealth-atlas-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function pdfEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines: string[]) {
  const content = [`BT`, `/F1 14 Tf`, `50 780 Td`, ...lines.flatMap((line, index) => [`(${pdfEscape(line)}) Tj`, index < lines.length - 1 ? "0 -20 Td" : ""]), `ET`].join("\n");
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = pdf.length; pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

export async function exportPdfReport(data: WealthData, report: "monthly" | "annual" | "net-worth" | "investment" | "asset" | "fx" | "cashflow") {
  const forecast = getCashFlowForecast(data, 30);
  const lines = [
    `Wealth Atlas ${report} report`,
    `Generated: ${new Date().toISOString()}`,
    `Report currency: ${data.reportCurrency}`,
    `Current accounts: ${formatMoney(totalInCurrency(data, data.reportCurrency), data.reportCurrency)}`,
    `30-day projected balance: ${formatMoney(forecast.endBalance, forecast.currency)}`,
    `Safety balance: ${formatMoney(forecast.safetyBalance, forecast.currency)}`,
    `Free to spend: ${formatMoney(forecast.freeToSpend, forecast.currency)}`,
    `Transactions: ${data.transactions.filter((item) => !item.deleted).length}`,
    `Investments: ${(data.investments ?? []).length}`,
    `Liabilities: ${(data.liabilities ?? []).length}`,
  ];
  downloadBlob(buildPdf(lines), `wealth-atlas-${report}-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export async function exportChartPng(data: WealthData, chart: "cashflow" | "net-worth" | "currency" | "income-expense" | "savings" | "assets" | "fx" | "investment" | "watchlist") {
  const canvas = document.createElement("canvas");
  canvas.width = 1400;
  canvas.height = 820;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持 PNG 图表导出");
  context.fillStyle = "#06101d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#eef6ff";
  context.font = "bold 34px system-ui";
  context.fillText(`Wealth Atlas / ${chart}`, 70, 86);
  context.font = "18px system-ui";
  context.fillStyle = "#8292ab";
  context.fillText(`Generated ${new Date().toISOString().slice(0, 10)} · ${data.reportCurrency}`, 70, 122);
  const forecast = getCashFlowForecast(data, 30);
  const values = chart === "cashflow" ? [forecast.startBalance, forecast.endBalance, forecast.safetyBalance, forecast.freeToSpend] : chart === "net-worth" ? [totalInCurrency(data, data.reportCurrency), ...(data.netWorthHistory ?? []).slice(-3).map((item) => item.value)] : chart === "currency" ? ["MYR", "SGD", "USD"].map((currency) => data.accounts.filter((account) => account.currency === currency).reduce((sum, account) => sum + account.balance, 0)) : [data.transactions.filter((item) => !item.deleted && item.type === "income").reduce((sum, item) => sum + item.amount, 0), data.transactions.filter((item) => !item.deleted && item.type === "expense").reduce((sum, item) => sum + item.amount, 0), data.assets.reduce((sum, item) => sum + item.currentValue, 0)];
  const numericValues = values.map((value) => typeof value === "number" ? value : 0);
  const max = Math.max(1, ...numericValues);
  numericValues.forEach((value, index) => { const x = 100 + index * 300; const height = Math.max(8, (value / max) * 500); context.fillStyle = index % 2 ? "#3cd9f5" : "#8fe1b4"; context.fillRect(x, 680 - height, 150, height); context.fillStyle = "#eef6ff"; context.font = "18px system-ui"; context.fillText(formatMoney(value, data.reportCurrency), x, 720); });
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法生成 PNG")), "image/png"));
  downloadBlob(blob, `wealth-atlas-${chart}-${new Date().toISOString().slice(0, 10)}.png`);
}

export type ObsidianZipScope = "daily" | "monthly" | "yearly" | "full";

function filesForScope(data: WealthData, scope: ObsidianZipScope, date = new Date().toISOString().slice(0, 10)) {
  const year = date.slice(0, 4);
  const files: Array<{ path: string; content: string }> = [];
  if (scope === "daily" || scope === "full") files.push({ path: `财富理财师/01-每日/${year}/${date}.md`, content: buildDailyMarkdown(data, date) });
  if (scope === "monthly" || scope === "full") files.push({ path: `财富理财师/02-每月/${year}/${date.slice(0, 7)}.md`, content: buildMonthlyMarkdown(data, date.slice(0, 7)) });
  if (scope === "yearly" || scope === "full") files.push({ path: `财富理财师/03-每年/${year}.md`, content: buildYearlyMarkdown(data, Number(year)) });
  if (scope === "full") data.assets.forEach((asset) => files.push({ path: `财富理财师/06-物品资产/${asset.id}.md`, content: buildAssetMarkdown(data, asset.id) }));
  if (scope === "full") {
    const templates = { ...getDefaultObsidianTemplates(), ...(data.obsidianTemplates ?? {}) };
    const templateNames: Record<ObsidianTemplateKey, string> = { daily: "每日模板.md", monthly: "每月模板.md", yearly: "每年模板.md", goal: "储蓄目标模板.md", asset: "资产模板.md", review: "财务复盘模板.md" };
    (Object.keys(templateNames) as ObsidianTemplateKey[]).forEach((key) => files.push({ path: `财富理财师/99-模板/${templateNames[key]}`, content: templates[key] }));
    files.push({ path: "财富理财师/00-总览/财富总览.md", content: `# 财富理财师\n\n- 报告货币：${data.reportCurrency}\n- 导出时间：${new Date().toISOString()}\n` });
  }
  return files;
}

export async function exportObsidianZip(data: WealthData, scope: ObsidianZipScope = "full") {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  filesForScope(data, scope).forEach((file) => zip.file(file.path, file.content));
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `wealth-atlas-obsidian-${scope}-${new Date().toISOString().slice(0, 10)}.zip`);
}

export async function exportObsidianPackage(data: WealthData) {
  return exportObsidianZip(data, "full");
}
