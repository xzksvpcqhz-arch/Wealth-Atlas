import { createDisplayPreferences, parseDisplayPreferences, type DisplayPreferences } from "./display-preferences";

export type DisplayRemote = { revision: number; preferences: DisplayPreferences };
export type DisplaySyncStatus = "local" | "waiting" | "syncing" | "ready" | "conflict" | "error";
export type DisplaySyncMeta = { version: 1; revision: number; base: DisplayPreferences };
export interface DisplayPreferenceTransport {
  read: () => Promise<DisplayRemote | null>;
  write: (value: DisplayPreferences, expectedRevision: number | null) => Promise<DisplayRemote | null>;
}
const equal = (a: DisplayPreferences, b: DisplayPreferences) => JSON.stringify(a) === JSON.stringify(b);
export function parseDisplaySyncMeta(raw: string | null): DisplaySyncMeta | null {
  if (raw === null) return null;
  if (raw.length > 40_000) throw new Error("Invalid display sync metadata");
  try {
    const value = JSON.parse(raw);
    const base = parseDisplayPreferences(value?.base);
    if (!base || value.version !== 1 || Object.keys(value).sort().join(",") !== "base,revision,version" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error();
    return { version: 1, revision: value.revision, base };
  } catch { throw new Error("Invalid display sync metadata"); }
}
export function parseDisplayRemote(value: unknown): DisplayRemote | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const preferences = parseDisplayPreferences(row.preferences);
  return preferences && typeof row.revision === "number" && Number.isSafeInteger(row.revision) && row.revision > 0 ? { revision: row.revision, preferences } : null;
}

/** No financial inputs, no merge into snapshots, no last-writer-wins. */
export function createDisplayPreferenceSync(options: {
  transport: DisplayPreferenceTransport;
  isActive: () => boolean;
  local: () => { value: DisplayPreferences; stored: boolean; dirty: boolean };
  applyRemote: (value: DisplayPreferences) => boolean;
  readMeta: () => string | null;
  saveMeta: (value: DisplaySyncMeta) => boolean;
  onStatus: (status: DisplaySyncStatus) => void;
}) {
  let disposed = false, inFlight: Promise<void> | null = null, repeat = false;
  let conflict: DisplayRemote | null | undefined;
  const active = () => !disposed && options.isActive();
  const status = (value: DisplaySyncStatus) => { if (!disposed) options.onStatus(value); };
  const acknowledge = (remote: DisplayRemote) => {
    if (!active()) return false;
    if (!options.saveMeta({ version: 1, revision: remote.revision, base: remote.preferences })) { status("error"); return false; }
    return true;
  };
  async function execute(choice?: "local" | "remote") {
    if (!active()) { status("waiting"); return; }
    status("syncing");
    try {
      const meta = parseDisplaySyncMeta(options.readMeta());
      const remote = await options.transport.read();
      if (!active()) return;
      const local = options.local();
      if (!parseDisplayPreferences(local.value)) { status("error"); return; }
      if (remote && !parseDisplayRemote(remote)) { status("error"); return; }
      if (choice && conflict === undefined) { status("conflict"); return; }
      if (choice && (remote?.revision ?? null) !== (conflict?.revision ?? null)) { conflict = remote; status("conflict"); return; }
      if (local.dirty) { status("waiting"); return; }

      if (choice === "remote") {
        const chosen = remote?.preferences ?? createDisplayPreferences();
        if (!options.applyRemote(chosen)) { status("conflict"); return; }
        if (remote && !acknowledge(remote)) return;
        conflict = undefined; status(remote ? "ready" : "local"); return;
      }
      if (remote && equal(local.value, remote.preferences)) {
        if (acknowledge(remote)) { conflict = undefined; status("ready"); } return;
      }
      const localUnchanged = meta ? equal(local.value, meta.base) : !local.stored;
      const remoteUnchanged = meta ? !!remote && remote.revision === meta.revision && equal(remote.preferences, meta.base) : remote === null;
      if (choice !== "local" && remote && localUnchanged) {
        if (!options.applyRemote(remote.preferences)) { status("conflict"); return; }
        if (acknowledge(remote)) { conflict = undefined; status("ready"); } return;
      }
      if (choice !== "local" && !remote && !local.stored && !meta) { status("ready"); return; }
      if (choice !== "local" && !remoteUnchanged) { conflict = remote; status("conflict"); return; }
      const outgoing = parseDisplayPreferences(local.value)!;
      const written = await options.transport.write(outgoing, remote?.revision ?? null);
      if (!active()) return;
      if (!written) { conflict = remote; status("conflict"); return; }
      if (!parseDisplayRemote(written) || !equal(written.preferences, outgoing) || written.revision <= (remote?.revision ?? 0)) { status("error"); return; }
      if (!acknowledge(written)) return;
      conflict = undefined;
      if (!equal(options.local().value, outgoing)) { repeat = true; status("waiting"); }
      else status("ready");
    } catch { if (active()) status("error"); }
  }
  const run = (choice?: "local" | "remote"): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) { if (!choice) repeat = true; return inFlight; }
    inFlight = execute(choice).finally(() => {
      inFlight = null;
      if (repeat && active()) { repeat = false; void run(); }
    });
    return inFlight;
  };
  return { sync: () => run(), resolve: (choice: "local" | "remote") => run(choice), dispose: () => { disposed = true; repeat = false; } };
}
