import { parseDisplayPreferences, type DisplayPreferences, type DisplayScope } from "./display-preferences";

// Display-only snapshots. No authentication, financial records or cloud access.
export type NamedLayout = { id: string; name: string; preferences: DisplayPreferences };
export type NamedLayoutLibrary = { version: 1; schemes: NamedLayout[] };
export type NamedLayoutEnvelope = {
  version: 1;
  library: NamedLayoutLibrary;
  base: { revision: number; library: NamedLayoutLibrary } | null;
};
export type NamedLayoutReadResult = {
  envelope: NamedLayoutEnvelope;
  raw: string | null;
  status: "default" | "stored" | "invalid" | "unavailable" | "locked";
};
export type NamedLayoutWriteResult =
  | { ok: true; raw: string }
  | { ok: false; reason: "inactive" | "invalid" | "conflict" | "unavailable" | "unsupported" };

const STORAGE_PREFIX = "wealth-atlas.named-display-layouts.v1";
const MAX_RAW_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Include invisible formatting controls, line separators and unpaired surrogates.
const UNSAFE_NAME = new RegExp("[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]", "u");

export function createNamedLayoutLibrary(): NamedLayoutLibrary {
  return { version: 1, schemes: [] };
}

export function normalizeLayoutName(value: string): string | null {
  if (typeof value !== "string" || UNSAFE_NAME.test(value)) return null;
  const name = value.normalize("NFKC").trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 30 && !UNSAFE_NAME.test(name) ? name : null;
}

// Deliberately not locale-sensitive or Unicode case folding. Call on normalized names.
export function layoutNameKey(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

// Match the display-preferences parser: only exact own enumerable data fields,
// plain/null-prototype records and ordinary dense arrays; never invoke getters.
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function boundedSchemes(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > 10) return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

export function parseNamedLayoutLibrary(value: unknown): NamedLayoutLibrary | null {
  try {
    const root = exactRecord(value, ["version", "schemes"]);
    if (!root || root.version !== 1) return null;
    const schemes = boundedSchemes(root.schemes);
    if (!schemes) return null;
    const result = createNamedLayoutLibrary();
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const value of schemes) {
      const item = exactRecord(value, ["id", "name", "preferences"]);
      if (!item || typeof item.id !== "string" || item.id.length !== 36 || !UUID.test(item.id)
        || typeof item.name !== "string") return null;
      const name = normalizeLayoutName(item.name);
      // Stored names must already be canonical; the helper normalizes UI input.
      if (name === null || name !== item.name) return null;
      const key = layoutNameKey(name);
      if (ids.has(item.id) || names.has(key)) return null;
      const preferences = parseDisplayPreferences(item.preferences);
      if (!preferences) return null;
      ids.add(item.id);
      names.add(key);
      result.schemes.push({ id: item.id, name, preferences });
    }
    return result;
  } catch {
    // Revoked/hostile proxies are invalid input, not exceptions to callers.
    return null;
  }
}

export function parseNamedLayoutEnvelope(value: unknown): NamedLayoutEnvelope | null {
  try {
    const root = exactRecord(value, ["version", "library", "base"]);
    if (!root || root.version !== 1) return null;
    const library = parseNamedLayoutLibrary(root.library);
    if (!library) return null;
    if (root.base === null) return { version: 1, library, base: null };
    const base = exactRecord(root.base, ["revision", "library"]);
    if (!base || typeof base.revision !== "number" || !Number.isSafeInteger(base.revision)
      || base.revision < 1 || base.revision > 2147483647) return null;
    const baseLibrary = parseNamedLayoutLibrary(base.library);
    return baseLibrary ? { version: 1, library, base: { revision: base.revision, library: baseLibrary } } : null;
  } catch {
    return null;
  }
}

export function namedLayoutStorageKey(scope: DisplayScope): string | null {
  try {
    const value = exactRecord(scope, ["kind", "ownerId"]);
    if (!value || (value.ownerId !== null && typeof value.ownerId !== "string")) return null;
    // Same scope rules as display preferences; never include local/guest metadata.
    if (value.kind === "local" || value.kind === "guest") return `${STORAGE_PREFIX}.${value.kind}`;
    if (value.kind === "cloud" && typeof value.ownerId === "string" && value.ownerId.length >= 1
      && value.ownerId.length <= 128 && !/[^A-Za-z0-9_-]/.test(value.ownerId)) {
      return `${STORAGE_PREFIX}.cloud.${value.ownerId}`;
    }
    return null;
  } catch {
    return null;
  }
}

function withinRawLimit(raw: string): boolean {
  // Cheap first bound avoids encoding an arbitrarily large storage string.
  return raw.length <= MAX_RAW_BYTES && new TextEncoder().encode(raw).byteLength <= MAX_RAW_BYTES;
}

function parseRaw(raw: string): NamedLayoutEnvelope | null {
  try {
    return withinRawLimit(raw) ? parseNamedLayoutEnvelope(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function readNamedLayouts(scope: DisplayScope): NamedLayoutReadResult {
  const fallback = (status: NamedLayoutReadResult["status"], raw: string | null = null): NamedLayoutReadResult => ({
    envelope: { version: 1, library: createNamedLayoutLibrary(), base: null }, raw, status,
  });
  const key = namedLayoutStorageKey(scope);
  if (key === null) return fallback("locked");
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (raw === null) return fallback("default");
    if (typeof raw !== "string") return fallback("unavailable");
    const envelope = parseRaw(raw);
    return envelope ? { envelope, raw, status: "stored" } : fallback("invalid", raw);
  } catch {
    return fallback("unavailable");
  }
}

export async function writeNamedLayouts(
  scope: DisplayScope,
  envelope: NamedLayoutEnvelope,
  expectedRaw: string | null,
  active: () => boolean,
): Promise<NamedLayoutWriteResult> {
  const isActive = () => {
    try { return typeof active === "function" && active() === true; } catch { return false; }
  };
  const key = namedLayoutStorageKey(scope);
  if (key === null || !isActive()) return { ok: false, reason: "inactive" };
  const parsed = parseNamedLayoutEnvelope(envelope);
  if (!parsed || (expectedRaw !== null && typeof expectedRaw !== "string")) return { ok: false, reason: "invalid" };
  try {
    // Snapshot synchronously before waiting for the lock; never retain caller data.
    const raw = JSON.stringify(parsed);
    if (!withinRawLimit(raw) || (expectedRaw !== null && !withinRawLimit(expectedRaw))) return { ok: false, reason: "invalid" };
    const locks = globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== "function") return { ok: false, reason: "unsupported" };
    const result = await locks.request(key, { mode: "exclusive" }, (): NamedLayoutWriteResult => {
      if (!isActive()) return { ok: false, reason: "inactive" };
      const storage = globalThis.localStorage;
      const getItem = storage.getItem;
      if (!isActive()) return { ok: false, reason: "inactive" };
      const currentRaw = getItem.call(storage, key);
      if (!isActive()) return { ok: false, reason: "inactive" };
      if (currentRaw !== null && typeof currentRaw !== "string") return { ok: false, reason: "unavailable" };
      if (currentRaw !== expectedRaw) return { ok: false, reason: "conflict" };
      // Corrupt/unknown data needs explicit recovery, never an ordinary save.
      if (currentRaw !== null && !parseRaw(currentRaw)) return { ok: false, reason: "invalid" };
      if (!isActive()) return { ok: false, reason: "inactive" };
      if (raw === currentRaw) return { ok: true, raw };
      const setItem = storage.setItem;
      if (!isActive()) return { ok: false, reason: "inactive" };
      setItem.call(storage, key, raw);
      const readback = getItem.call(storage, key);
      if (!isActive()) return { ok: false, reason: "inactive" };
      return readback === raw ? { ok: true, raw } : { ok: false, reason: "unavailable" };
    });
    return isActive() ? result : { ok: false, reason: "inactive" };
  } catch {
    // No identities, storage contents or exception details in returned diagnostics.
    return { ok: false, reason: isActive() ? "unavailable" : "inactive" };
  }
}
