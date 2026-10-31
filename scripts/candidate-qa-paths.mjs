import path from "node:path";

const p = path.win32;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const normalize = value => typeof value === "string" && p.isAbsolute(value) ? p.resolve(value).toLowerCase() : null;

/** QA-only path classification, not an application storage setting. Never accept
 * manual profiles, arbitrary redirects or a different QA UUID. A recognized
 * package-view alias still requires a separate OS directory-identity check. */
export function classifyCandidateQaPath({ expected, resolved, qaRoot, appData, userProfile, version }) {
  if (![expected, resolved, qaRoot, appData, userProfile].every(value => normalize(value))) return "refused";
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) return "refused";
  const base = p.join(appData, "Wealth Atlas Sync Candidate", version, "isolated-qa");
  const id = p.relative(base, qaRoot);
  if (!uuid.test(id) || normalize(p.join(base, id)) !== normalize(qaRoot)) return "refused";
  if (![qaRoot, p.join(qaRoot, "logs")].some(value => normalize(value) === normalize(expected))) return "refused";
  if (normalize(expected) === normalize(resolved)) return "canonical";
  const packages = p.join(userProfile, "AppData", "Local", "Packages");
  const parts = p.relative(packages, resolved).split(p.sep);
  if (!/^OpenAI\.Codex_[a-z0-9]{13}$/i.test(parts[0] ?? "")
    || parts[1]?.toLowerCase() !== "localcache" || parts[2]?.toLowerCase() !== "roaming") return "refused";
  const expectedSuffix = p.relative(appData, expected).toLowerCase();
  return parts.slice(3).join(p.sep).toLowerCase() === expectedSuffix ? "codex-package-view" : "refused";
}

export function sameDirectoryIdentity(left, right) {
  const ordinary = value => value?.isDirectory() === true && value?.isSymbolicLink() === false;
  const identifier = value => typeof value === "bigint" || typeof value === "number" && Number.isSafeInteger(value);
  return ordinary(left) && ordinary(right) && identifier(left.dev) && identifier(left.ino)
    && left.ino > 0 && left.dev === right.dev && left.ino === right.ino;
}
