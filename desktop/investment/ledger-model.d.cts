export function cashReserve(input: {endBalance: number; safety: number; budgets: Array<{key: string; remaining: number; coveredPlanned: number}>}): {budgetReserve: number; available: number};
