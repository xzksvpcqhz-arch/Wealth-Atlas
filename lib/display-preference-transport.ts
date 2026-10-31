import type { SupabaseClient } from "@supabase/supabase-js";
import { parseDisplayPreferences } from "./display-preferences";
import { parseDisplayRemote, type DisplayPreferenceTransport } from "./display-preference-sync";

/** Uses the existing authenticated client. Never requests financial tables. */
export function createDisplayPreferenceTransport(client: SupabaseClient, ownerId: string, active: () => boolean, signal: AbortSignal, timeoutMs = 15_000): DisplayPreferenceTransport {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error("Invalid display owner");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid display deadline");
  async function request<T>(run: (requestSignal: AbortSignal) => PromiseLike<T>): Promise<T> {
    if (signal.aborted || !active()) throw new Error("Display session changed");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      cancel = () => { controller.abort(); reject(new Error("Display request stopped")); };
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(cancel, timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted || !active()) throw new Error("Display session changed"); return run(controller.signal); }), stopped]); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }
  return {
    async read() {
      if (!active()) throw new Error("Display session changed");
      const result = await request(requestSignal => client.from("user_ui_preferences").select("revision,preferences").eq("user_id", ownerId).abortSignal(requestSignal).maybeSingle());
      if (result.error) throw new Error("Display read unavailable");
      if (result.data === null) return null;
      const row = parseDisplayRemote(result.data); if (!row) throw new Error("Invalid display response"); return row;
    },
    async write(value, expectedRevision) {
      const preferences = parseDisplayPreferences(value);
      if (!active() || !preferences) throw new Error("Display session changed");
      const table = client.from("user_ui_preferences");
      const query = expectedRevision === null ? table.insert({ user_id: ownerId, preferences }) : table.update({ preferences }).eq("user_id", ownerId).eq("revision", expectedRevision);
      const result = await request(requestSignal => query.select("revision,preferences").abortSignal(requestSignal).maybeSingle());
      if (result.error?.code === "23505") return null;
      if (result.error) throw new Error("Display write unavailable");
      if (result.data === null) return null;
      const row = parseDisplayRemote(result.data); if (!row) throw new Error("Invalid display response"); return row;
    },
  };
}
