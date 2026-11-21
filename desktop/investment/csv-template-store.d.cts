export type CsvTemplateBook = {
  version: 1;
  revision: number;
  templates: Array<{
    id: string;
    name: string;
    kind: 'snapshot' | 'trades';
    headers: string[];
    mapping: Record<string, string>;
  }>;
};

export type CsvTemplateScope = {
  kind: 'local' | 'guest' | 'cloud' | 'locked';
  key: string;
  ownerId: string | null;
  epoch: number;
};

export function createCsvTemplateStore<Scope extends CsvTemplateScope>(options: {
  getScope: () => Scope;
  assertScope: (scope: Scope) => void;
  indexedDB?: IDBFactory | null;
}): {
  read(): Promise<CsvTemplateBook>;
  write(expectedBook: CsvTemplateBook, nextBook: CsvTemplateBook): Promise<CsvTemplateBook>;
  close(): void;
};
