// Local installer preparation only. Never installs, publishes, tags or adopts profiles.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicProbeConfig } from "./check-cloud-permissions.mjs";
import { isOlderStableVersion } from "./release-acceptance.mjs";

export const LOCAL_RELEASE_VERSION = "1.7.6";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = /(^|\/)(?:\.env[^/]*|data|exports|private-vault|backups|outputs|review|certificates|userprofiles|realfinance|vaults?)(?:\/|$)|\.(?:pfx|p12|pem|key|xlsx|csv|zip)$|update-token\.json$/i;
export function assertLocalReleaseInput(relative) {
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).some((part) => part === "..")
    || forbidden.test(relative.replaceAll("\\", "/"))) throw new Error("Private or unsafe release input refused before reading it.");
}

function cleanBuildEnvironment(environment, publicConfig) {
  const result = {};
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS"]) {
    if (environment[key]) result[key] = environment[key];
  }
  result.PATH = environment.Path || environment.PATH;
  Object.assign(result, { NEXT_TELEMETRY_DISABLED: "1", NPM_CONFIG_UPDATE_NOTIFIER: "false", CSC_IDENTITY_AUTO_DISCOVERY: "false",
    NEXT_PUBLIC_SUPABASE_URL: publicConfig.url.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: publicConfig.key });
  // Optional public redirect configuration only; never infer an origin from credentials.
  if (environment.NEXT_PUBLIC_APP_URL?.trim()) {
    const address = new URL(environment.NEXT_PUBLIC_APP_URL.trim());
    if (!/^https?:$/.test(address.protocol) || address.username || address.password || address.search || address.hash) throw new Error("Invalid public redirect configuration; value suppressed.");
    result.NEXT_PUBLIC_APP_URL = address.href;
  }
  return result;
}

function run(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Local release preparation failed; existing files were preserved and nothing was installed or published.")));
  });
}

export async function buildLocalRelease() {
  if (process.platform !== "win32") throw new Error("Windows local installer preparation requires Windows.");
  if (process.env.WEALTH_ATLAS_PUBLISH === "1") throw new Error("This local-only command cannot publish.");
  const publicConfig = publicProbeConfig(process.env); // Only public process variables. Never loads .env files.
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.version !== LOCAL_RELEASE_VERSION && !isOlderStableVersion(pkg.version, LOCAL_RELEASE_VERSION)) throw new Error("Local candidate version must not downgrade the source version.");
  const baselineVersion = "1.7.4";
  const baselineInstaller = path.join(root, "desktop-dist", `v${baselineVersion}`, "Wealth-Atlas-Setup.exe");
  const baselineStat = await lstat(baselineInstaller);
  if (!baselineStat.isFile() || baselineStat.isSymbolicLink() || baselineStat.nlink !== 1) throw new Error("The reviewed baseline installer is unavailable.");
  const id = randomUUID();
  const source = path.join(path.dirname(root), "wealth-atlas-release-preparation", id, "source");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(root, "desktop-dist", "release-candidates", `v${LOCAL_RELEASE_VERSION}-${stamp}-${id.slice(0, 8)}`);
  const sourceHashes = {};
  // Public assets are approved HEAD files only, not arbitrary ignored/untracked uploads.
  const publicFiles = new Set(execFileSync("git", ["ls-files", "-z", "--", "public"], { cwd: root }).toString("utf8").split("\0").filter(Boolean));
  if (execFileSync("git", ["diff", "HEAD", "--name-only", "--", "public"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Public assets changed since the approved source; review them before release.");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  async function copy(relative) {
    assertLocalReleaseInput(relative);
    if (relative.startsWith("public/") && !publicFiles.has(relative) && ![...publicFiles].some((file) => file.startsWith(relative + "/"))) return;
    const from = path.join(root, relative), to = path.join(source, relative), stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error("Release source links are refused.");
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from)) await copy(path.posix.join(relative, entry));
    } else if (stat.isFile() && stat.nlink === 1) {
      const bytes = await readFile(from);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString("utf8"))) throw new Error("Private key material refused; content suppressed.");
      sourceHashes[relative] = digest(bytes);
      await copyFile(from, to);
    } else throw new Error("Nonregular release input refused.");
  }
  await mkdir(source, { recursive: true });
  for (const folder of ["app", "components", "lib", "public", "desktop", "build", "scripts", "tests", "release"]) await copy(folder);
  for (const name of ["package.json", "package-lock.json", "next.config.mjs", "postcss.config.mjs", "tsconfig.json", "next-env.d.ts"]) await copy(name);
  // Generated staging metadata only; the working tree package/lock versions remain unchanged.
  await writeFile(path.join(source, "package.json"), JSON.stringify({ ...pkg, version: LOCAL_RELEASE_VERSION }, null, 2) + "\n");
  const lock = JSON.parse(await readFile(path.join(source, "package-lock.json"), "utf8"));
  lock.version = LOCAL_RELEASE_VERSION; lock.packages[""].version = LOCAL_RELEASE_VERSION;
  await writeFile(path.join(source, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  await symlink(path.join(root, "node_modules"), path.join(source, "node_modules"), "junction");
  const extractorRoot = path.join(path.dirname(source), "extractor");
  await mkdir(extractorRoot);
  // The installed vendor tool requires a companion named 7z.dll. Copy both,
  // never rename/move the originals or depend on the operator's PATH.
  await copyFile(path.join(root, "node_modules", "electron-winstaller", "vendor", "7z-x64.exe"), path.join(extractorRoot, "7z.exe"), 1);
  await copyFile(path.join(root, "node_modules", "electron-winstaller", "vendor", "7z-x64.dll"), path.join(extractorRoot, "7z.dll"), 1);
  const env = { ...cleanBuildEnvironment(process.env, publicConfig), WEALTH_ATLAS_LOCAL_CANDIDATE: "1",
    WEALTH_ATLAS_RELEASE_SOURCE_ROOT: root, WEALTH_ATLAS_RELEASE_DIR: destination,
    WEALTH_ATLAS_BASELINE_VERSION: baselineVersion, WEALTH_ATLAS_BASELINE_INSTALLER: baselineInstaller,
    WEALTH_ATLAS_TEST_EXTRACTOR: path.join(extractorRoot, "7z.exe"),
    NPM_CONFIG_USERCONFIG: path.join(source, "no-user-config.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(source, "no-global-config.npmrc") };
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  await writeFile(path.join(path.dirname(source), "source-inventory.json"), JSON.stringify({ version: LOCAL_RELEASE_VERSION, sourceCommit: head,
    sourceHasUncommittedChanges: dirty, sourceHashes, source, destination, environmentFilesRead: false,
    financialDataAccessed: false, rootVersionChanged: false, published: false }, null, 2) + "\n", { flag: "wx" });
  await mkdir(destination);
  await writeFile(path.join(destination, "local-candidate-provenance.json"), JSON.stringify({ localCandidate: true, version: LOCAL_RELEASE_VERSION, sourceCommit: head, runId: id }) + "\n", { flag: "wx" });
  console.log(`Preparing local-only UNSIGNED installer ${LOCAL_RELEASE_VERSION}; no installation or GitHub publication.`);
  await run([path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "run", "build"], source,
    { ...env, WEALTH_ATLAS_DESKTOP_BUILD: "1", NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP: "1" });
  await run(["scripts/windows-release.mjs"], source, env);
  // Bind final evidence to the still-unchanged reviewed input, not merely the old HEAD label.
  for (const [file, hash] of Object.entries(sourceHashes)) {
    if (digest(await readFile(path.join(root, file))) !== hash) throw new Error("Source changed during local packaging; do not distribute this candidate.");
  }
  const report = JSON.parse(await readFile(path.join(destination, "release-check.json"), "utf8"));
  if (report.version !== LOCAL_RELEASE_VERSION || report.localCandidate !== true || report.distributionReady !== false || report.runtimeAcceptanceVerified !== true) throw new Error("Local candidate verification did not complete.");
  await writeFile(path.join(destination, "local-candidate.json"), JSON.stringify({ status: "LOCAL_CANDIDATE_PASS", version: LOCAL_RELEASE_VERSION,
    sourceCommit: head, sourceHasUncommittedChanges: dirty, sourceFilesVerified: Object.keys(sourceHashes).length,
    source, destination, sha256: report.sha256, signature: report.release, baselineVersion,
    installedIntoUserProfile: false, financialDataAccessed: false, published: false, distributionReady: false }, null, 2) + "\n", { flag: "wx" });
  console.log(`Local installer candidate verified, NOT installed or published: ${destination}`);
  return { source, destination, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await buildLocalRelease(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
