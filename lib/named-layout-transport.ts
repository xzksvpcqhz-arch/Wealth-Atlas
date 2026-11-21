import type { SupabaseClient } from "@supabase/supabase-js";
import { parseNamedLayoutLibrary } from "./named-display-layouts";
import { parseNamedLayoutRemote, type NamedLayoutTransport } from "./named-layout-sync";

export function createNamedLayoutTransport(client: SupabaseClient, ownerId: string, active: () => boolean, signal: AbortSignal, timeoutMs = 15_000): NamedLayoutTransport {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid layout session");
  async function request<T>(run: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    if (!active() || signal.aborted) throw new Error("Layout session changed");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => { abort.abort(); reject(new Error("Layout request stopped")); };
      signal.addEventListener("abort", cancel, { once: true }); timer = setTimeout(cancel, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (!active() || abort.signal.aborted) throw new Error("Layout session changed");
        return run(abort.signal);
      }), stopped]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }
  return {
    async read() {
      const result = await request(s => client.from("user_ui_layout_libraries").select("revision,library").eq("user_id", ownerId).abortSignal(s).maybeSingle());
      if (result.error) throw new Error("Layout library read unavailable");
      if (result.data === null) return null;
      const row = parseNamedLayoutRemote(result.data); if (!row) throw new Error("Invalid layout library response"); return row;
    },
    async write(input, expectedRevision) {
      const library = parseNamedLayoutLibrary(input);
      if (!active() || !library || expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= 2147483647)) throw new Error("Invalid layout write");
      const table = client.from("user_ui_layout_libraries");
      const query = expectedRevision === null ? table.insert({ user_id: ownerId, library }) : table.update({ library }).eq("user_id", ownerId).eq("revision", expectedRevision);
      const result = await request(s => query.select("revision,library").abortSignal(s).maybeSingle());
      if (result.error?.code === "23505" || !result.error && result.data === null) return null;
      if (result.error) throw new Error("Layout library write unavailable");
      const row = parseNamedLayoutRemote(result.data); if (!row) throw new Error("Invalid layout library response"); return row;
    },
  };
}
