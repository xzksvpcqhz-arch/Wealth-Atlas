import type { Account } from "./types";

function isAvailableAccount(account: Account) {
  return account.status !== "inactive" && account.status !== "deleted";
}

export function getAccountDescendantIds(accounts: Account[], accountId: string) {
  const descendants = new Set<string>();
  const queue = [accountId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) continue;
    for (const account of accounts) {
      if (account.parentAccountId !== currentId || descendants.has(account.id)) continue;
      descendants.add(account.id);
      queue.push(account.id);
    }
  }

  return descendants;
}

export function getAvailableMainAccounts(accounts: Account[], editingAccountId?: string | null) {
  const excludedIds = editingAccountId
    ? new Set([editingAccountId, ...getAccountDescendantIds(accounts, editingAccountId)])
    : new Set<string>();

  return accounts.filter((account) =>
    isAvailableAccount(account)
    && !account.parentAccountId
    && !excludedIds.has(account.id),
  );
}

export function validateAccountParent(
  accounts: Account[],
  editingAccountId: string | null,
  parentAccountId: string | null | undefined,
) {
  if (!parentAccountId) return { valid: true as const };
  const parent = accounts.find((account) => account.id === parentAccountId);
  const currentAccount = editingAccountId ? accounts.find((account) => account.id === editingAccountId) : undefined;
  if (!parent || !isAvailableAccount(parent)) {
    return { valid: false as const, message: "选择的主账号不可用，请重新选择" };
  }
  if (editingAccountId && parentAccountId === editingAccountId) {
    return { valid: false as const, message: "账户不能选择自己作为主账号" };
  }
  if (editingAccountId && getAccountDescendantIds(accounts, editingAccountId).has(parentAccountId)) {
    return { valid: false as const, message: "账户不能选择自己的子账户作为主账号" };
  }
  if (currentAccount?.parentAccountId === parentAccountId) {
    return { valid: true as const };
  }
  if (parent.parentAccountId) {
    return { valid: false as const, message: "只能选择顶层主账号，不能产生多层或循环关系" };
  }
  if (editingAccountId && accounts.some((account) => account.parentAccountId === editingAccountId)) {
    return { valid: false as const, message: "该主账号已有子账户，请先调整子账户后再更改层级" };
  }
  return { valid: true as const };
}

export function getAccountRootId(accounts: Account[], accountId: string) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const visited = new Set<string>();
  let currentId = accountId;

  while (true) {
    if (visited.has(currentId)) return [...visited].sort()[0] ?? accountId;
    visited.add(currentId);
    const parentId = accountById.get(currentId)?.parentAccountId;
    if (!parentId || !accountById.has(parentId)) return currentId;
    currentId = parentId;
  }
}
