import type {CsvTemplateBook} from './csv-template-store.cjs';
export interface WorkbenchContext {
  holdings?: Array<{name: string; account?: string; currentValue: number; currency: string; asOf: string}>;
  cashflow?: {until: string; currency: string; startBalance: number; income: number; expenses: number; reserves: number; endBalance: number; budgetReserve: number; safety: number; available: number; note?: string} | null;
}
export function createWorkbench(options: {
  api: (route: string, payload?: unknown) => Promise<any>;
  onResearch?: (alias: string) => Promise<unknown>;
  context?: WorkbenchContext;
  storageTarget?: "vault" | "account";
  templateStore?: {read():Promise<CsvTemplateBook>;write(expected:CsvTemplateBook,next:CsvTemplateBook):Promise<CsvTemplateBook>};
}): { mount(target: HTMLElement): void; updateContext(value: WorkbenchContext): void; destroy(): void };
