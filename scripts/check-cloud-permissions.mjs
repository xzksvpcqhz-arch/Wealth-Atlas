import { pathToFileURL } from "node:url";

// Only the two public build variables are accepted. Never load an env file,
// authenticate a real user, query financial rows or print a request/response body.
export function publicProbeConfig(environment) {
  const address = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const fail = () => { throw new Error("Public cloud configuration is absent or unsafe; values suppressed."); };
  if (!address || !key || /\s/.test(key) || key.startsWith("sb_secret_")) return fail();
  let url;
  try { url = new URL(address); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || /^(localhost|127\.|0\.|\[::1\])/.test(url.hostname)) return fail();
  let anonymous = false;
  try { anonymous = JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8")).role === "anon"; } catch { /* Publishable keys are not JWTs. */ }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && !anonymous) return fail();
  return { url, key };
}

export async function probeAnonymousPrivileges(environment, fetcher = fetch) {
  const { url, key } = publicProbeConfig(environment);
  const target = new URL("/rest/v1/user_data", url);
  target.search = "select=id&limit=0";
  try {
    const response = await fetcher(target, {
      method: "HEAD", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { apikey: key, Accept: "application/json" },
    });
    // Do not read any response bytes, including on an unexpected HTTP result.
    const denied = response.status === 401 || response.status === 403;
    return {
      status: denied ? "ANONYMOUS_REQUEST_DENIED" : "NEEDS_METADATA_REVIEW",
      httpStatus: response.status, financialRowsRequested: 0, liveIsolationVerified: false,
      note: denied ? "Anonymous request denied; authenticated A/B isolation and catalog checks still required."
        : "This zero-row probe cannot prove RLS. Inspect the read-only catalog audit; no rows were requested.",
    };
  } catch {
    return { status: "UNREACHABLE", financialRowsRequested: 0, liveIsolationVerified: false,
      note: "Request failed or timed out; URL, credentials and provider details suppressed." };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeAnonymousPrivileges(process.env);
    console.log(JSON.stringify(result, null, 2));
    // A zero-row probe never reports a full security PASS.
    process.exitCode = result.status === "ANONYMOUS_REQUEST_DENIED" ? 0 : 2;
  } catch {
    console.error("Public cloud configuration is absent or unsafe; no request made and no values printed.");
    process.exitCode = 1;
  }
}
