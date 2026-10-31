import type { SupabaseClient } from "@supabase/supabase-js";
import type { CloudSnapshot, CloudSyncTransport } from "./cloud-merge";
import type { WealthData } from "./types";
import { CloudTransportError } from "./cloud-retry";

export function classifyTransportStatus(status: number) {
  if (status === 401) return "authentication" as const;
  if (status === 403) return "permission" as const;
  if (status === 0) return "network" as const;
  if ([408, 425, 429].includes(status) || status >= 500) return "server" as const;
  return "safety" as const;
}

async function request<T>(run: (signal: AbortSignal) => PromiseLike<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CloudTransportError("network")); }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof CloudTransportError) throw error;
    throw new CloudTransportError("network");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function snapshot(row: unknown): CloudSnapshot {
  const item = row as { data?: WealthData; updated_at?: string } | null;
  if (!item?.data || typeof item.data !== "object" || Array.isArray(item.data)
    || typeof item.updated_at !== "string" || !Number.isFinite(Date.parse(item.updated_at))) {
    throw new Error("云端版本资料不完整，已停止同步，本机资料未被覆盖。");
  }
  return { data: item.data, updatedAt: item.updated_at };
}

/** Uses the existing server-maintained updated_at as the atomic CAS guard. */
export function createSnapshotTransport(sb: SupabaseClient, userId: string, timeoutMs = 20000): CloudSyncTransport {
  return {
    async pull() {
      const { data, error, status } = await request((signal) => sb.from("user_data").select("data, updated_at").eq("user_id", userId).abortSignal(signal).maybeSingle(), timeoutMs);
      if (error) throw new CloudTransportError(classifyTransportStatus(status));
      return data ? snapshot(data) : null;
    },
    async compareAndSet(data, expected) {
      // INSERT only: a competing initial upload must never replace the existing row.
      const query = expected
        ? sb.from("user_data").update({ data, updated_at: new Date().toISOString() })
          .eq("user_id", userId).eq("updated_at", expected.updatedAt)
        : sb.from("user_data").insert({ user_id: userId, data });
      const result = await request((signal) => query.select("data, updated_at").abortSignal(signal).maybeSingle(), timeoutMs);
      if (!expected && result.error?.code === "23505") return null;
      if (expected && result.error?.code === "PGRST116" && /\b0 rows\b/.test(result.error.details ?? "")) return null;
      if (result.error) throw new CloudTransportError(classifyTransportStatus(result.status));
      if (!result.data) return null;
      const saved = snapshot(result.data);
      if (expected && saved.updatedAt === expected.updatedAt) {
        throw new Error("云端版本标记未更新，已暂停同步。请检查服务器的版本时间戳配置。");
      }
      return saved;
    },
  };
}
