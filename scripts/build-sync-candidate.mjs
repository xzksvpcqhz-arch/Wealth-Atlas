import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, lstat, copyFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { Arch, Platform, build } from "electron-builder";
import { listPackage, extractFile } from "@electron/asar";
import { publicProbeConfig } from "./check-cloud-permissions.mjs";

export const CANDIDATE_VERSION = "1.7.5-rc.13";
// User explicitly approved reusing rc.5's candidate profile for this update.
// Does not adopt/copy the production profile or change financial storage.
export const CANDIDATE_PROFILE_VERSION = "1.7.5-rc.5";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /(^|\/)(?:\.env[^/]*|data|exports|private-vault|backups|outputs|review|certificates)(?:\/|$)|\.(?:pfx|p12|pem|key)$|update-token\.json$/i;
export function assertCandidatePath(relative) {
  if (forbidden.test(relative.replaceAll("\\", "/")) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("Candidate input contains a forbidden path; no private file was read.");
}
async function copyTree(source, destination, relative = "") {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name); assertCandidatePath(name);
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if ((await lstat(from)).isSymbolicLink()) throw new Error("Candidate source links are not accepted.");
    if (entry.isDirectory()) await copyTree(from, to, name); else if (entry.isFile()) await copyFile(from, to);
  }
}
function run(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: "inherit" });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Candidate build step failed; no release was published.")));
  });
}
async function zipTree(directory, target) {
  const zip = new JSZip();
  async function add(folder, relative = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const key = path.posix.join(relative, entry.name); assertCandidatePath(key);
      if (entry.isSymbolicLink()) throw new Error("Archive links are not accepted.");
      if (entry.isDirectory()) await add(path.join(folder, entry.name), key);
      else zip.file(key, await readFile(path.join(folder, entry.name)), { unixPermissions: key.endsWith(".command") ? 0o755 : 0o644 });
    }
  }
  await add(directory);
  await writeFile(target, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE", compressionOptions: { level: 3 } }));
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildSyncCandidate() {
  // Build in a sibling scratch folder: copying TS under this app's work/ would
  // accidentally include those copies in the original project's type-check glob.
  const source = path.join(path.dirname(root), "wealth-atlas-candidate-work", randomUUID(), "source");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(root, "desktop-dist", "candidates", `v${CANDIDATE_VERSION}-${stamp}`);
  const appStage = path.join(path.dirname(source), "desktop-app");
  const webStage = path.join(destination, "mac-web");
  const publicConfig = publicProbeConfig(process.env);
  const env = { ...process.env, NEXT_PUBLIC_SUPABASE_URL: publicConfig.url.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: publicConfig.key,
    NEXT_TELEMETRY_DISABLED: "1", CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  if (!env.NEXT_PUBLIC_APP_URL?.trim()) delete env.NEXT_PUBLIC_APP_URL;
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  // One marker name per independent candidate build, not one new file per boot.
  const visibilityProbeId = randomUUID();
  await mkdir(source, { recursive: true }); await mkdir(destination, { recursive: true });
  for (const directory of ["app", "components", "lib", "public", "desktop", "build"]) await copyTree(path.join(root, directory), path.join(source, directory), directory);
  for (const name of ["next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts"]) await copyFile(path.join(root, name), path.join(source, name));
  await writeFile(path.join(source, "package.json"), JSON.stringify({ ...pkg, version: CANDIDATE_VERSION }, null, 2));
  await symlink(path.join(root, "node_modules"), path.join(source, "node_modules"), "junction");
  const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
  console.log(`Building local-only sync candidate ${CANDIDATE_VERSION}. No GitHub publication or real profile access.`);
  await run([next, "build"], source, { ...env, WEALTH_ATLAS_DESKTOP_BUILD: "1", NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP: "1", WEALTH_ATLAS_WEB_EXPORT: "0" });
  await copyTree(path.join(source, "out"), path.join(appStage, "out"), "out");
  await copyTree(path.join(source, "desktop"), path.join(appStage, "desktop"), "desktop");
  await copyTree(path.join(source, "build"), path.join(appStage, "build"), "build");
  await copyFile(path.join(root, "scripts", "candidate-bootstrap.cjs"), path.join(appStage, "desktop", "candidate-bootstrap.cjs"));
  await writeFile(path.join(appStage, "package.json"), JSON.stringify({ name: "wealth-atlas-sync-candidate", productName: "Wealth Atlas Sync Candidate",
    version: CANDIDATE_VERSION, description: "Unpublished isolated cloud-sync acceptance candidate", author: "Wealth Atlas", private: true,
    main: "desktop/candidate-bootstrap.cjs", wealthAtlasCandidate: "cloud-sync-test",
    wealthAtlasCandidateProfileVersion: CANDIDATE_PROFILE_VERSION,
    wealthAtlasCandidateVisibilityProbeId: visibilityProbeId, dependencies: {} }, null, 2));
  const electronVersion = JSON.parse(await readFile(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
  await build({ targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64), projectDir: root, publish: "never", config: {
    appId: "com.wealthatlas.sync-candidate", productName: "Wealth Atlas Sync Candidate", asar: true, npmRebuild: false,
    electronVersion, electronDist: path.join(root, "node_modules", "electron", "dist"),
    directories: { app: appStage, output: path.join(destination, "windows") },
    files: ["out/**/*", "desktop/*.cjs", "desktop/auth-diagnostic-codes.json", "build/icon.svg", "package.json", "!node_modules/**/*"],
    win: { target: "dir", icon: path.join(root, "build", "icon.svg"), signExecutable: false }, publish: null,
  } });
  const windowsApp = path.join(destination, "windows", "win-unpacked");
  const asar = path.join(windowsApp, "resources", "app.asar");
  const packaged = listPackage(asar);
  for (const file of packaged) assertCandidatePath(file.replace(/^[\\/]+/, ""));
  const embedded = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
  if (embedded.version !== CANDIDATE_VERSION || embedded.main !== "desktop/candidate-bootstrap.cjs" || embedded.wealthAtlasCandidate !== "cloud-sync-test"
    || embedded.wealthAtlasCandidateProfileVersion !== CANDIDATE_PROFILE_VERSION
    || embedded.wealthAtlasCandidateVisibilityProbeId !== visibilityProbeId) throw new Error("Candidate isolation metadata check failed.");
  const bootstrap = extractFile(asar, path.normalize("desktop/candidate-bootstrap.cjs"));
  if (!bootstrap.equals(await readFile(path.join(root, "scripts", "candidate-bootstrap.cjs")))) throw new Error("Candidate bootstrap mismatch.");
  for (const file of ["desktop/main.cjs", "desktop/preload.cjs", "desktop/updater.cjs", "desktop/data-profiles.cjs", "desktop/candidate-diagnostics.cjs", "desktop/startup-diagnostics.cjs", "desktop/auth-trace.cjs", "desktop/diagnostic-visibility.cjs", "desktop/auth-diagnostic-codes.json"]) {
    if (!extractFile(asar, path.normalize(file)).equals(await readFile(path.join(root, file)))) throw new Error("Candidate source mismatch.");
  }
  await run([next, "build"], source, { ...env, WEALTH_ATLAS_DESKTOP_BUILD: "0", NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP: "", WEALTH_ATLAS_WEB_EXPORT: "1" });
  await copyTree(path.join(source, "out"), path.join(webStage, "site"), "site");
  await copyFile(path.join(root, "scripts", "candidate-web-server.mjs"), path.join(webStage, "candidate-web-server.mjs"));
  await copyFile(path.join(root, "scripts", "candidate-mac.command"), path.join(webStage, "Start-Wealth-Atlas-Test.command"));
  await copyFile(path.join(root, "docs", "SYNC_CANDIDATE_TEST.md"), path.join(webStage, "TESTING-GUIDE.md"));
  const instructions = `Wealth Atlas ${CANDIDATE_VERSION} — SYNC TEST ONLY / 未发布测试版\n\n`
    + `Windows: extract the ENTIRE Windows ZIP and open Wealth Atlas Sync Candidate.exe. No installer or uninstall is needed.\n`
    + `Test profile: %APPDATA%\\Wealth Atlas Sync Candidate\\${CANDIDATE_PROFILE_VERSION} (same directory as rc.5/rc.6, explicitly approved; NOT the production Wealth Atlas folder). Close older candidates before starting this version. No copying, clearing or migration. Automatic updates are disabled.\n\n`
    + `MacBook: extract the Mac-Web ZIP. Install Node.js LTS from https://nodejs.org/en/download if missing. Open Start-Wealth-Atlas-Test.command; then open http://127.0.0.1:43175/ in your browser. Keep Terminal open.\n`
    + `The server binds only to your own Mac, not Wi-Fi or the Internet. Do NOT double-click site/index.html. Use the same address and browser each time. Ctrl+C stops the server without clearing browser data.\n\n`
    + `Updating the Mac test: KEEP the old folder/ZIP, extract this version into a NEW folder, stop only the old Terminal server with Ctrl+C, then start this version on the SAME 127.0.0.1:43175 address. Do not clear browser data; Node does not need reinstalling.\n`
    + `rc.6 introduced receipt-bound offline reopening after an access token expires, but did NOT pass the user's physical offline restart acceptance. rc.7 remains a repair candidate, not a validated final fix. Only an exact previously server-verified session plus a matching existing workspace can reopen locally, within the existing 24-hour verification window. Uploads remain paused until online verification succeeds. Missing/revoked sessions are NOT recreated from email history. Read TESTING-GUIDE.md. Never share passwords or recovery links.\n`
    + `rc.7 did NOT pass the user's physical offline restart/reconnect acceptance. rc.8 checks exact local proof BEFORE SDK construction, retains an already-open unexpired local grant only during transient re-verification, and prevents a pending failed restore from silently becoming a blank guest on a missing session. Invalid/revoked sessions still lock access. Actual physical offline acceptance remains PENDING.\n`
    + `rc.8 writes candidate-startup-diagnostic.json beside this candidate executable, containing only version, a random boot ID, time and fixed technical codes (no identity, token or financial content). It is separate from financial profiles and is not uploaded. No cached email can authorize access.\n`
    + `rc.9 includes the independently reviewed auth-boundary patch: a transient null SDK session stays locked with bounded retry, queued explicit login/logout keeps the latest intent, and external sign-out or owner changes still fence access immediately. No verification lifetime, financial schema or UI changes. Automated tests do not replace physical offline acceptance.\n`
    + `rc.9 did NOT pass the user's real restart acceptance. rc.10 requires the SDK to use its original browser storage explicitly instead of silently falling back to memory. Storage failures must be reported, not treated as a durable login. It cannot recreate a missing/revoked session; the user may need to sign in personally once after the candidate switch. No financial data reset, token backup, email-based authorization or automatic recovery is performed.\n`
    + `rc.10 did NOT pass the user's real normal-close/offline-reopen acceptance. rc.11 ONLY adds fixed-enum startup directory checks and log-write failure classification to the candidate sidecar. Paths, credentials and financial payloads are NOT recorded. No authentication, offline proof, financial data model or UI change is included. It does NOT claim to fix the missing-session cause; switching to it requires separate user confirmation.\n`
    + `rc.12 adds candidate-auth-trace.json beside the executable: a bounded fixed-code timeline for the latest two boots, SDK session-storage observations and normal close/quit events. It shares a random boot ID with candidate-startup-diagnostic.json. No key, token, email, snapshot, financial data or path is recorded. Readback is NOT a disk-durability guarantee, missing events are NOT proof of no deletion, and the user's real normal-X cause is still UNPROVEN. The previous rc.11 bundle is retained; do not switch without user confirmation. No restore, migration, automatic login or financial-model/UI change.\n`
    + `rc.13 ONLY adds an explicitly enabled Windows startup visibility probe: one fixed-content diagnostic-visibility-<build UUID>.txt in the candidate logs directory. It never reads or replaces an existing marker. Fixed technical codes beside the executable distinguish create/write/readback failure. The build UUID is in candidate-check.json; it is not a credential. This does NOT read authentication/financial storage or prove it durable, fix the missing-session cause, or authorize switching from rc.12. No DevTools or safety-warning bypass is required.\n`
    + `Ordinary logout remains session-local (rc.5 fix); older builds can still revoke other devices. This Windows package reuses the explicitly approved rc.5 candidate profile, even when double-clicked directly. No existing profile is copied, cleared, restored or migrated. Synthetic QA still uses a separate current-version UUID profile. Email history remains email-only, opt-in and never logs you in. Physical offline acceptance on your machine remains a separate manual check.\n\n`
    + `Sign into the same EMPTY TEST account on Windows and Mac. Do not send passwords to the developer. Use invented records only. Do not import personal backups or connect a real Obsidian Vault.\n`
    + `Unsigned Windows package: Windows may warn about an unknown publisher. This is not a signed release. No OS security controls are disabled by the launcher.\n`
    + `No GitHub upload, update feed, certificate, private key or financial data is included. Hosted multi-device acceptance and actual macOS execution remain pending.\n`;
  await writeFile(path.join(webStage, "READ-ME-FIRST.txt"), instructions, "utf8");
  await writeFile(path.join(windowsApp, "READ-ME-FIRST.txt"), instructions, "utf8");
  await writeFile(path.join(destination, "READ-ME-FIRST.txt"), instructions, "utf8");
  const windowsZip = path.join(destination, `Wealth-Atlas-Sync-Test-v${CANDIDATE_VERSION}-Windows-UNSIGNED.zip`);
  const macZip = path.join(destination, `Wealth-Atlas-Sync-Test-v${CANDIDATE_VERSION}-Mac-Web.zip`);
  await zipTree(windowsApp, windowsZip); await zipTree(webStage, macZip);
  const hashes = {};
  for (const file of [windowsZip, macZip]) { hashes[path.basename(file)] = sha256(await readFile(file)); }
  const sourceFileHashes = {};
  for (const file of ["lib/password-recovery.ts", "lib/supabase-client.ts", "lib/cloud-sync.ts", "lib/auth-session.ts", "lib/auth-storage.ts", "lib/auth-diagnostics.ts", "lib/storage.ts", "lib/account-boundary.ts", "lib/login-history.ts", "lib/use-cloud-sync.ts", "components/CloudSyncPanel.tsx", "app/globals.css", "desktop/main.cjs", "desktop/preload.cjs", "desktop/auth-diagnostic-codes.json", "desktop/candidate-diagnostics.cjs", "desktop/startup-diagnostics.cjs", "desktop/auth-trace.cjs", "desktop/diagnostic-visibility.cjs"]) {
    sourceFileHashes[file] = sha256(await readFile(path.join(source, file)));
  }
  const report = { status: "BUILT_FOR_MANUAL_TEST", version: CANDIDATE_VERSION, sourceCommit: sourceHead, sourceHasUncommittedChanges: true,
    signature: "UNSIGNED", distributionReady: false, githubPublished: false, autoUpdatesEnabled: false,
    financialDataIncluded: false, financeSchemaChanged: false, hostedAuthVerified: false, hostedTwoDeviceVerified: false,
    macRuntimeVerified: false, candidatePurpose: "profile-log-visibility-diagnostics", visibilityProbeId, profileVersion: CANDIDATE_PROFILE_VERSION,
    profile: `%APPDATA%\\Wealth Atlas Sync Candidate\\${CANDIDATE_PROFILE_VERSION}`, sourceFileHashes, hashes };
  await writeFile(path.join(destination, "candidate-check.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(destination, "SHA256SUMS.txt"), Object.entries(hashes).map(([name, hash]) => `${hash}  ${name}`).join("\n") + "\n");
  console.log(`Candidate built, NOT published: ${destination}`);
  return { destination, windowsApp, webStage, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await buildSyncCandidate(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
