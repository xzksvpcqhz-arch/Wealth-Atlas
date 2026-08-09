import type { WealthData } from "./types";
import { formatMoney } from "./finance";

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function buildDailyMarkdown(data: WealthData, date = new Date().toISOString().slice(0, 10)) {
  const today = data.transactions.filter((item) => item.date === date);
  const expenses = today.filter((item) => item.type === "expense");
  const income = today.filter((item) => item.type === "income");
  return `---\ntype: daily-finance\ndate: ${date}\nreport_currency: ${data.reportCurrency}\nobsidian_source: wealth-atlas\n---\n\n# ${date}\n\n## 今日收入\n\n${income.length ? income.map((item) => `- ${item.category}: ${formatMoney(item.amount, item.currency)}`).join("\\n") : "- 暂无记录"}\n\n## 今日支出\n\n${expenses.length ? expenses.map((item) => `- ${item.category}: ${formatMoney(item.amount, item.currency)}${item.merchant ? `，${item.merchant}` : ""}`).join("\\n") : "- 暂无记录"}\n\n## 财务备注\n\n- 今日预算状态：待复盘\n- 关联月份：[[${date.slice(0, 7)}]]\n`;
}

export async function exportExcel(data: WealthData) {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Wealth Atlas";
  const transactions = workbook.addWorksheet("Transactions");
  transactions.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Type", key: "type", width: 12 },
    { header: "Category", key: "category", width: 20 },
    { header: "Amount", key: "amount", width: 14 },
    { header: "Currency", key: "currency", width: 12 },
    { header: "Merchant", key: "merchant", width: 22 },
    { header: "Note", key: "note", width: 30 },
  ];
  data.transactions.forEach((item) => transactions.addRow(item));

  const transfers = workbook.addWorksheet("Transfers");
  transfers.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "From", key: "fromCurrency", width: 12 },
    { header: "From Amount", key: "fromAmount", width: 16 },
    { header: "To", key: "toCurrency", width: 12 },
    { header: "To Amount", key: "toAmount", width: 16 },
    { header: "Rate", key: "rate", width: 14 },
    { header: "Fee", key: "fee", width: 12 },
  ];
  data.transfers.forEach((item) => transfers.addRow(item));

  const goals = workbook.addWorksheet("Goals");
  goals.columns = [
    { header: "Goal", key: "name", width: 24 },
    { header: "Current", key: "current", width: 16 },
    { header: "Target", key: "target", width: 16 },
    { header: "Currency", key: "currency", width: 12 },
    { header: "Progress", key: "percent", width: 12 },
    { header: "Due", key: "due", width: 14 },
  ];
  data.goals.forEach((item) => goals.addRow(item));

  const fx = workbook.addWorksheet("FX Rates");
  fx.columns = [
    { header: "Pair", key: "pair", width: 16 },
    { header: "Rate", key: "rate", width: 16 },
    { header: "Effective Date", key: "date", width: 18 },
    { header: "Note", key: "note", width: 30 },
  ];
  data.fxRates.forEach((item) => fx.addRow({ pair: `${item.baseCurrency}/${item.quoteCurrency}`, rate: item.rate, date: item.effectiveDate, note: item.note }));

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer]), `wealth-atlas-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function buildMonthlyMarkdown(data: WealthData, month = new Date().toISOString().slice(0, 7)) {
  const transactions = data.transactions.filter((item) => item.date.startsWith(month));
  const income = transactions.filter((item) => item.type === "income");
  const expenses = transactions.filter((item) => item.type === "expense");
  const total = (items: typeof transactions) => items.reduce((sum, item) => sum + item.amount, 0);
  return `---\ntype: monthly-finance\nmonth: ${month}\nreport_currency: ${data.reportCurrency}\nobsidian_source: wealth-atlas\n---\n\n# Monthly review — ${month}\n\n- Income records: ${income.length}\n- Expense records: ${expenses.length}\n- Income (original currencies): ${total(income).toLocaleString()}\n- Expenses (original currencies): ${total(expenses).toLocaleString()}\n\n## Goals\n\n${data.goals.map((goal) => `- ${goal.name}: ${goal.percent}% (${goal.current.toLocaleString()} / ${goal.target.toLocaleString()} ${goal.currency})`).join("\\n")}\n\n## Review notes\n\n- What worked:\n- What needs adjustment:\n- Next month focus:\n`;
}

export function buildYearlyMarkdown(data: WealthData, year = new Date().getFullYear()) {
  const transactions = data.transactions.filter((item) => item.date.startsWith(String(year)));
  const months = new Set(transactions.map((item) => item.date.slice(0, 7))).size;
  return `---\ntype: yearly-finance\nyear: ${year}\nreport_currency: ${data.reportCurrency}\nobsidian_source: wealth-atlas\n---\n\n# Yearly review — ${year}\n\n- Active months: ${months}\n- Transaction count: ${transactions.length}\n- Accounts: ${data.accounts.length}\n- Goals: ${data.goals.length}\n- Assets: ${data.assets.length}\n\n## Year-end reflection\n\n- Biggest win:\n- Biggest leak:\n- What to protect next year:\n- Next year's first money move:\n`;
}

export async function exportObsidianPackage(data: WealthData) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const year = now.getFullYear();
  const root = "\u8d22\u5bcc\u7406\u8d22\u5e08";
  zip.file(`${root}/00-\u603b\u89c8/\u8d22\u5bcc\u603b\u89c8.md`, `# Wealth Atlas\n\n- Report currency: ${data.reportCurrency}\n- Last export: ${now.toLocaleString("zh-CN")}\n`);
  zip.file(`${root}/01-\u6bcf\u65e5/${year}/${date}.md`, buildDailyMarkdown(data, date));
  zip.file(`${root}/02-\u6bcf\u6708/${year}/${month}.md`, buildMonthlyMarkdown(data, month));
  zip.file(`${root}/03-\u6bcf\u5e74/${year}.md`, buildYearlyMarkdown(data, year));
  zip.file(`${root}/99-\u6a21\u677f/\u6bcf\u6708\u6a21\u677f.md`, `---\ntype: monthly-finance\n---\n\n# {{month}}\n\n## Review notes\n`);
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `wealth-atlas-obsidian-${year}.zip`);
}

export async function exportObsidianZip(data: WealthData) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const year = new Date().getFullYear();
  const dailyPath = `财富理财师/01-每日/${year}/${new Date().toISOString().slice(0, 10)}.md`;
  zip.file(dailyPath, buildDailyMarkdown(data));
  zip.file(`财富理财师/00-总览/财富总览.md`, `# 财富总览\n\n- 报告货币：${data.reportCurrency}\n- 最后同步：${new Date().toLocaleString("zh-CN")}\n`);
  zip.file(`财富理财师/99-模板/每日模板.md`, `---\ntype: daily-finance\n---\n\n# {{date}}\n\n## 今日收入\n\n## 今日支出\n\n## 财务备注\n`);
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, `wealth-atlas-obsidian-${year}.zip`);
}
