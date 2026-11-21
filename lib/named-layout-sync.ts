import { createNamedLayoutLibrary, parseNamedLayoutLibrary, type NamedLayoutEnvelope, type NamedLayoutLibrary } from "./named-display-layouts";
import type { DisplaySyncStatus } from "./display-preference-sync";

export type NamedLayoutRemote = { revision: number; library: NamedLayoutLibrary };
export type NamedLayoutConflictToken = { remote: number | null; local: string | null };
export interface NamedLayoutTransport {
  read(): Promise<NamedLayoutRemote | null>;
  write(value: NamedLayoutLibrary, expectedRevision: number | null): Promise<NamedLayoutRemote | null>;
}
export function parseNamedLayoutRemote(input: unknown): NamedLayoutRemote | null {
  try {
    if (!input || typeof input !== "object") return null;
    const row = input as Record<string, unknown>;
    const library = parseNamedLayoutLibrary(row.library);
    return library && Number.isInteger(row.revision) && (row.revision as number) > 0 && (row.revision as number) <= 2147483647
      ? { revision: row.revision as number, library } : null;
  } catch { return null; }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Separate from both current-display sync and financial sync. Entire-library
 * revision conflicts require an explicit choice; no silent last-writer-wins. */
export function createNamedLayoutSync(options: {
  transport: NamedLayoutTransport;
  active(): boolean;
  local(): { envelope: NamedLayoutEnvelope; raw: string | null };
  commit(value: NamedLayoutEnvelope, expectedRaw: string | null): Promise<boolean>;
  onStatus(status: DisplaySyncStatus): void;
}) {
  let disposed = false, pending: Promise<DisplaySyncStatus> | null = null, repeat = false;
  let currentStatus: DisplaySyncStatus = "waiting";
  let conflict: NamedLayoutConflictToken | undefined;
  const active = () => !disposed && options.active();
  const status = (s: DisplaySyncStatus) => { if (active()) { currentStatus = s; options.onStatus(s); } };
  async function execute(choice?: "local" | "remote", confirmed?: NamedLayoutConflictToken | null) {
    if (!active()) return;
    status("syncing");
    try {
      const remote = await options.transport.read();
      if (!active()) return;
      if (remote && !parseNamedLayoutRemote(remote)) throw new Error("Invalid layout response");
      const snapshot = options.local();
      const { library, base } = snapshot.envelope;
      if (!parseNamedLayoutLibrary(library)) throw new Error("Invalid layout library");
      // Bind the choice to what the user saw when opening the confirmation.
      // Background polling cannot re-authorize an older modal for newer data.
      if (choice && (!confirmed || !conflict || confirmed.remote !== conflict.remote || confirmed.local !== conflict.local || confirmed.remote !== (remote?.revision ?? null) || confirmed.local !== snapshot.raw)) {
        conflict = { remote: remote?.revision ?? null, local: snapshot.raw }; status("conflict"); return;
      }
      const commit = async (value: NamedLayoutLibrary, acknowledged: NamedLayoutRemote | null) => {
        if (!active()) return false;
        const ok = await options.commit({ version: 1, library: value, base: acknowledged ? { revision: acknowledged.revision, library: acknowledged.library } : null }, snapshot.raw);
        if (!active()) return false;
        if (!ok) { conflict = { remote: acknowledged?.revision ?? null, local: options.local().raw }; status("conflict"); return false; }
        conflict = undefined; status("ready"); return true;
      };
      if (choice === "remote") { await commit(remote?.library ?? createNamedLayoutLibrary(), remote); return; }
      if (remote && equal(library, remote.library)) { await commit(library, remote); return; }
      const localUnchanged = base ? equal(library, base.library) : library.schemes.length === 0;
      const remoteUnchanged = base ? !!remote && remote.revision === base.revision && equal(remote.library, base.library) : remote === null;
      if (!choice && remote && localUnchanged) { await commit(remote.library, remote); return; }
      if (!choice && !remote && !base && !library.schemes.length) { conflict = undefined; status("ready"); return; }
      if (!choice && !remoteUnchanged) { conflict = { remote: remote?.revision ?? null, local: snapshot.raw }; status("conflict"); return; }
      const written = await options.transport.write(library, remote?.revision ?? null);
      if (!active()) return;
      if (!written) { conflict = { remote: remote?.revision ?? null, local: snapshot.raw }; status("conflict"); return; }
      if (!parseNamedLayoutRemote(written) || written.revision <= (remote?.revision ?? 0) || !equal(written.library, library)) throw new Error("Invalid layout acknowledgement");
      await commit(library, written);
    } catch { status("error"); }
  }
  const run = (choice?: "local" | "remote", confirmed?: NamedLayoutConflictToken | null): Promise<DisplaySyncStatus> => {
    if (disposed) return Promise.resolve("waiting");
    // A decision that was not executed cannot borrow a background sync's result.
    if (pending) { if (choice) return Promise.resolve("waiting"); repeat = true; return pending; }
    // Capture this operation's outcome BEFORE a queued background sync starts.
    // Reading the mutable live status after awaiting could observe its successor.
    pending = execute(choice, confirmed).then(() => currentStatus).finally(() => {
      pending = null;
      if (repeat && active()) { repeat = false; void run(); }
    });
    return pending;
  };
  return { sync: () => run(), resolve: (choice: "local" | "remote", confirmed: NamedLayoutConflictToken | null) => run(choice, confirmed), getConflictToken: () => conflict ? { ...conflict } : null, getStatus: () => currentStatus, dispose() { disposed = true; repeat = false; } };
}
