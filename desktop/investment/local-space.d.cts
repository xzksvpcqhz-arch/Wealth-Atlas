export function createLocalInvestmentSpace(options: {
  getScope: () => {kind: string; ownerId: string | null};
  assertScope: (scope: any) => void;
}): {
  status(): Promise<{enabled: boolean; selected: boolean}>;
  enable(): Promise<{enabled: boolean}>;
  select(selected: boolean): Promise<void>;
  read(): Promise<any>;
  save(request: unknown): Promise<any>;
  close(): void;
};
