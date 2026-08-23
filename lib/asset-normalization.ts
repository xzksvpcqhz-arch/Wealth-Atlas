import {
  getAssetCostPerUse,
  getAssetCurrentCurrency,
  getAssetDailyCost,
  getAssetPurchaseCurrency,
  getAssetUsageDays,
  getLocalDate,
} from "./finance";
import type { WealthData } from "./types";

function normalizeAsset(asset: WealthData["assets"][number], today: string) {
  const currentCurrency = getAssetCurrentCurrency(asset);
  const purchaseCurrency = getAssetPurchaseCurrency(asset);
  const category = asset.name === "MacBook" ? "电脑" : asset.name === "相机" ? "相机" : asset.name === "黄金" ? "黄金" : asset.category;
  const usageStartMode = asset.usageStartMode ?? "purchaseDate";
  const usageStartDate = asset.usageStartDate ?? asset.purchaseDate;
  const normalized = { ...asset, category, purchaseCurrency, purchaseDate: asset.purchaseDate, usageStartMode, usageStartDate, currentCurrency, currency: currentCurrency, sellPrice: asset.sellPrice, saleDate: asset.saleDate, useCount: asset.useCount ?? 0 };
  const calculatedUsageDays = getAssetUsageDays(normalized, today);
  const usageDays = usageStartDate ? calculatedUsageDays : Math.max(0, asset.usageDays ?? 0);
  const legacyUsageDays = !asset.usageStartMode || !("usageStartDate" in asset)
    ? asset.usageDays !== undefined && usageStartDate && asset.usageDays !== calculatedUsageDays ? asset.usageDays : undefined
    : asset.legacyUsageDays;
  return { ...normalized, usageDays, legacyUsageDays, dailyCost: getAssetDailyCost({ ...normalized, usageDays }, today), costPerUse: getAssetCostPerUse({ ...normalized, usageDays }, today) ?? undefined };
}

export function normalizeAssets(assets: WealthData["assets"], today = getLocalDate()) {
  let migrated = 0;
  let recalculated = 0;
  const backups: NonNullable<WealthData["assetMigrationBackups"]> = [];
  const normalized = assets.map((asset) => {
    const next = normalizeAsset(asset, today);
    if (!asset.usageStartMode || !("usageStartDate" in asset)) {
      migrated += 1;
      if (asset.usageDays !== undefined) backups.push({ assetId: asset.id, backedUpAt: new Date().toISOString(), usageDays: asset.usageDays, purchaseDate: asset.purchaseDate });
    }
    if (next.legacyUsageDays !== undefined) recalculated += 1;
    return next;
  });
  return { normalized, migrated, recalculated, backups };
}
