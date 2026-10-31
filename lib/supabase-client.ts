import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { capturePasswordRecoveryIntent, observePasswordRecovery } from "./password-recovery";
import { createAuthStorage } from "./auth-storage";
import { reportAuthDiagnostic, reportAuthStorageActivity } from "./auth-diagnostics";

let client: SupabaseClient | null = null;

/** 是否已配置 Supabase（环境变量有 URL + anon key） */
export function isCloudConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** 惰性创建单例 Supabase 客户端；未配置则返回 null。 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!isCloudConfigured()) return null;
  if (!client) {
    capturePasswordRecoveryIntent();
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      { auth: { persistSession: true, autoRefreshToken: true, storage: createAuthStorage(undefined, reportAuthDiagnostic, reportAuthStorageActivity) } },
    );
    client.auth.onAuthStateChange((event, session) => {
      observePasswordRecovery(event, session?.user.id ?? null);
    });
  }
  return client;
}
