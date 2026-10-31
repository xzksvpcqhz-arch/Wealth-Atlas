import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import { listPackage, extractFile } from "@electron/asar";
import packageJson from "../package.json" with { type: "json" };
import { validateUpdateAssets } from "./github-release.mjs";
import { hashReleaseAssets, readInstalledReleaseAcceptance } from "./release-acceptance.mjs";
import { assertPackagedRuntimeDependencies } from "./runtime-dependencies.mjs";

const projectRoot = process.cwd();
const localCandidate = process.env.WEALTH_ATLAS_LOCAL_CANDIDATE === "1";
if (localCandidate && process.env.WEALTH_ATLAS_PUBLISH === "1") throw new Error("Local candidates cannot be published.");
if (!localCandidate && process.env.WEALTH_ATLAS_RELEASE_SOURCE_ROOT) throw new Error("Source overrides are local-candidate only.");
const sourceRoot = localCandidate && process.env.WEALTH_ATLAS_RELEASE_SOURCE_ROOT
  ? path.resolve(process.env.WEALTH_ATLAS_RELEASE_SOURCE_ROOT) : projectRoot;
const releaseDirectory = process.env.WEALTH_ATLAS_RELEASE_DIR?.trim() || path.join("desktop-dist", `v${packageJson.version}`);
const releasePath = path.resolve(projectRoot, releaseDirectory);
const installerPath = path.join(releasePath, "Wealth-Atlas-Setup.exe");
const unpackedExePath = path.join(releasePath, "win-unpacked", "Wealth Atlas.exe");
const asarPath = path.join(releasePath, "win-unpacked", "resources", "app.asar");
const sharePath = releasePath;
const expectedSigning = process.env.WEALTH_ATLAS_RELEASE_SIGNING === "SIGNED" ? "SIGNED" : "UNSIGNED";
const expectedPublisher = process.env.WINDOWS_PUBLISHER_NAME?.trim() ?? "";
const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition), detail });
  if (!condition) failures.push(`${name}: ${detail}`);
}

function getWindowsMetadata(filePath) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$target = $env:WEALTH_ATLAS_SIGNATURE_TARGET",
    "$item = Get-Item -LiteralPath $target",
    "$signature = Get-AuthenticodeSignature -LiteralPath $target",
    "[PSCustomObject]@{",
    "  signatureStatus = [string]$signature.Status",
    "  signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "  timeStamperSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { '' }",
    "  companyName = [string]$item.VersionInfo.CompanyName",
    "  productName = [string]$item.VersionInfo.ProductName",
    "  productVersion = [string]$item.VersionInfo.ProductVersion",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    // PowerShell 7 can pass an incompatible module path to Windows PowerShell 5.
    // Use its own built-in security module and fail closed if inspection fails.
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"), WEALTH_ATLAS_SIGNATURE_TARGET: filePath },
  });
  return JSON.parse(output.trim());
}

for (const requiredPath of [installerPath, unpackedExePath, asarPath]) {
  check("Required release file", existsSync(requiredPath), path.relative(projectRoot, requiredPath));
}
if (failures.length) throw new Error(failures.join("\n"));

const installerBytes = readFileSync(installerPath);
const sha256 = createHash("sha256").update(installerBytes).digest("hex").toUpperCase();
const installerMetadata = getWindowsMetadata(installerPath);
const appMetadata = getWindowsMetadata(unpackedExePath);
const expectedSignatureStatus = expectedSigning === "SIGNED" ? "Valid" : "NotSigned";

check("Windows executable header", installerBytes[0] === 0x4d && installerBytes[1] === 0x5a, "Installer must start with the PE MZ header.");
check("Installer version", installerMetadata.productVersion.startsWith(`${packageJson.version}.`) || installerMetadata.productVersion === packageJson.version, `${installerMetadata.productVersion} / expected ${packageJson.version}`);
check("Application version", appMetadata.productVersion.startsWith(`${packageJson.version}.`) || appMetadata.productVersion === packageJson.version, `${appMetadata.productVersion} / expected ${packageJson.version}`);
check("Product name", appMetadata.productName === packageJson.build.productName, appMetadata.productName);
check("Company name", appMetadata.companyName === "Wealth Atlas", appMetadata.companyName);
check("Installer signature", installerMetadata.signatureStatus === expectedSignatureStatus, installerMetadata.signatureStatus);
check("Application signature", appMetadata.signatureStatus === expectedSignatureStatus, appMetadata.signatureStatus);
if (expectedSigning === "SIGNED") {
  check("Signed publisher configured", Boolean(expectedPublisher), "WINDOWS_PUBLISHER_NAME is required.");
  check("Installer publisher", installerMetadata.signerSubject.includes(expectedPublisher), installerMetadata.signerSubject || "missing signer");
  check("Application publisher", appMetadata.signerSubject.includes(expectedPublisher), appMetadata.signerSubject || "missing signer");
  check("Installer RFC 3161 timestamp", Boolean(installerMetadata.timeStamperSubject), installerMetadata.timeStamperSubject || "missing timestamp signer");
  check("Application RFC 3161 timestamp", Boolean(appMetadata.timeStamperSubject), appMetadata.timeStamperSubject || "missing timestamp signer");
}

const packagedFiles = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").toLowerCase());
const embeddedPackage = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
// Artifact provenance survives rechecking without the process-only candidate flag.
const artifactIsLocalCandidate = localCandidate || embeddedPackage.wealthAtlasLocalReleaseCandidate === true
  || existsSync(path.join(releasePath, "local-candidate-provenance.json"));
check("Embedded application version", embeddedPackage.version === packageJson.version, embeddedPackage.version);
try {
  const count = assertPackagedRuntimeDependencies(listPackage(asarPath), (file) => JSON.parse(extractFile(asarPath, path.normalize(file)).toString("utf8")));
  check("Packaged runtime dependency closure", count > 0, `${count} runtime packages present with entry files.`);
} catch { check("Packaged runtime dependency closure", false, "Required updater/runtime module or entry is missing."); }
for (const relativePath of ["desktop/main.cjs", "desktop/preload.cjs", "desktop/updater.cjs"]) {
  const source = readFileSync(path.join(projectRoot, relativePath));
  const embedded = extractFile(asarPath, path.normalize(relativePath));
  check("Embedded source matches build input", source.equals(embedded), relativePath);
}
check("No embedded update token", !packagedFiles.includes("/desktop/update-token.json"), "Public update feeds require no embedded credential.");
const asarBytes = readFileSync(asarPath);
const privateBuildSecrets = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.WINDOWS_CERTIFICATE_PASSWORD, process.env.DEEPSEEK_API_KEY].filter((value) => value && value.length >= 8);
check("No private build credentials in package", !privateBuildSecrets.some((value) => asarBytes.includes(Buffer.from(value))), "Private secret values are never printed.");
try {
  validateUpdateAssets(["Wealth-Atlas-Setup.exe", "Wealth-Atlas-Setup.exe.blockmap", "latest.yml"].map((name) => ({ name, bytes: readFileSync(path.join(releasePath, name)) })), packageJson.version);
  check("Automatic update assets", true, "Installer, blockmap and manifest agree on version, size and SHA-512.");
} catch { check("Automatic update assets", false, "Missing or mismatched automatic update files."); }
const updateFeedPath = path.join(releasePath, "win-unpacked", "resources", "app-update.yml");
const updateFeed = readFileSync(updateFeedPath, "utf8");
check("Public GitHub update feed", /^provider:\s*github\s*$/m.test(updateFeed) && /^owner:\s*xzksvpcqhz-arch\s*$/m.test(updateFeed) && /^repo:\s*wealth-atlas\s*$/im.test(updateFeed)
  && !/^(?:token|authorization|private):/im.test(updateFeed), "Public repository feed without embedded credentials.");
const privatePath = /(^|\/)(?:\.env[^/]*|data|exports|private-vault|backups|outputs|review|certificates)(?:\/|$)|\.(?:pfx|p12|pem|key)$/i;
const forbiddenPackagedFiles = packagedFiles.filter((entry) => privatePath.test(entry));
check("Packaged private-data paths", forbiddenPackagedFiles.length === 0, forbiddenPackagedFiles.join(", ") || "none");

const trackedFiles = execFileSync("git", ["ls-files"], { cwd: sourceRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const trackedSecrets = trackedFiles.filter((entry) => /(^|\/)(?:\.env(?!\.example)(?:\.|$)|data\/|exports\/|private-vault\/|backups\/|outputs\/)|\.(?:pfx|p12|pem|key)$/i.test(entry));
check("Tracked secret containers", trackedSecrets.length === 0, trackedSecrets.join(", ") || "none");

const changedFiles = execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard"], { cwd: sourceRoot, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  // Refuse private containers by name before reading any bytes. Read only code/templates.
  .filter((entry) => !privatePath.test(entry) && !entry.split(/[\\/]/).includes("..")
    && (/^(?:app|components|lib|desktop|scripts|tests|supabase|docs|release|build)\//.test(entry)
      || /^(?:package(?:-lock)?\.json|[^/]+\.(?:md|mjs|json))$/.test(entry))
    && /\.(?:[cm]?js|jsx|tsx?|css|json|md|sql)$/.test(entry));
const sensitiveValues = [process.env.WINDOWS_CERTIFICATE_PASSWORD, process.env.DEEPSEEK_API_KEY].filter((value) => value && value.length >= 6);
let secretLeakDetected = false;
for (const relativePath of changedFiles) {
  const absolutePath = path.join(sourceRoot, relativePath);
  if (!existsSync(absolutePath)) continue;
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Changed-code scan refused a nonregular source file before reading it.");
  const content = readFileSync(absolutePath, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) || sensitiveValues.some((value) => content.includes(value))) {
    secretLeakDetected = true;
    break;
  }
}
check("Changed-code secret scan", !secretLeakDetected, secretLeakDetected ? "Sensitive material detected; value suppressed." : "no private key or supplied secret value detected");

const desktopMain = readFileSync(path.join(projectRoot, "desktop", "main.cjs"), "utf8");
check("Packaged development URL disabled", desktopMain.includes("app.isPackaged ? null"), "Packaged builds must ignore --dev-url.");
check("Independent desktop profile", desktopMain.includes('path.join(app.getPath("appData"), "Wealth Atlas")'), "%APPDATA%/Wealth Atlas");
check("Secure renderer isolation", desktopMain.includes("contextIsolation: true") && desktopMain.includes("nodeIntegration: false") && desktopMain.includes("sandbox: true"), "Electron renderer security flags");
check("Uninstall preserves app data", packageJson.build.nsis?.deleteAppDataOnUninstall === false, "deleteAppDataOnUninstall=false");
check("SHA-256 signing configured", JSON.stringify(packageJson.build.win?.signtoolOptions?.signingHashAlgorithms) === JSON.stringify(["sha256"]), "signingHashAlgorithms=[sha256]");
check("SHA-256 generated", /^[A-F0-9]{64}$/.test(sha256), sha256);

if (failures.length) {
  console.error("Windows release check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

mkdirSync(sharePath, { recursive: true });
const signatureLabel = expectedSigning === "SIGNED" ? "SIGNED" : "UNSIGNED";
const publisherLabel = expectedSigning === "SIGNED" ? installerMetadata.signerSubject : "No verified Authenticode publisher";
const checksumName = "Wealth-Atlas-Setup.exe.sha256";
writeFileSync(path.join(sharePath, checksumName), `${sha256} *Wealth-Atlas-Setup.exe\r\n`, "utf8");

const replacements = {
  "{{VERSION}}": packageJson.version,
  "{{SIGNATURE_STATUS}}": signatureLabel,
  "{{PUBLISHER}}": publisherLabel,
  "{{SHA256}}": sha256,
};
for (const templateName of ["INSTALL.md", "SECURITY.md", "RELEASE_NOTES.md"]) {
  let content = readFileSync(path.join(projectRoot, "release", "windows", templateName), "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) content = content.replaceAll(placeholder, value);
  writeFileSync(path.join(sharePath, templateName), content, "utf8");
}

const cloudConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
const sourceHasUncommittedChanges = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim());
let sourceTagMatches = false;
try { sourceTagMatches = execFileSync("git", ["rev-parse", `v${packageJson.version}^{commit}`], { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() === sourceCommit; } catch { /* Unapproved candidates remain undistributed. */ }
let runtimeAcceptanceVerified = false;
if (existsSync(path.join(releasePath, "installed-release-test.json"))) {
  // A malformed/stale report is a failure, not an absent optional check.
  readInstalledReleaseAcceptance(releasePath, { version: packageJson.version, sourceCommit, assetHashes: hashReleaseAssets(releasePath), localCandidate: artifactIsLocalCandidate });
  runtimeAcceptanceVerified = true;
}
if (!cloudConfigured) {
  const notesPath = path.join(sharePath, "RELEASE_NOTES.md");
  writeFileSync(notesPath, readFileSync(notesPath, "utf8") + "\n本地测试候选包：尚未注入现有云登录构建配置，不可上传为正式自动更新版本。\n", "utf8");
}
const report = {
  status: "PASS",
  release: signatureLabel,
  version: packageJson.version,
  publisher: publisherLabel,
  signatureStatus: installerMetadata.signatureStatus,
  sha256,
  installer: "Wealth-Atlas-Setup.exe",
  appData: "%APPDATA%\\Wealth Atlas",
  sourceCommit,
  sourceHasUncommittedChanges,
  sourceTagMatches,
  cloudConfigured,
  localCandidate: artifactIsLocalCandidate,
  runtimeAcceptanceVerified,
  distributionReady: !artifactIsLocalCandidate && cloudConfigured && !sourceHasUncommittedChanges && sourceTagMatches && runtimeAcceptanceVerified,
  checks,
};
writeFileSync(path.join(sharePath, "release-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const zip = new JSZip();
zip.file("Wealth-Atlas-Setup.exe", installerBytes);
for (const fileName of [checksumName, "INSTALL.md", "SECURITY.md", "RELEASE_NOTES.md", "release-check.json"]) {
  zip.file(fileName, readFileSync(path.join(sharePath, fileName)));
}
if (runtimeAcceptanceVerified) zip.file("installed-release-test.json", readFileSync(path.join(sharePath, "installed-release-test.json")));
const zipName = `Wealth-Atlas-v${packageJson.version}-Windows-${signatureLabel}.zip`;
const zipBytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "DOS" });
writeFileSync(path.join(sharePath, zipName), zipBytes);

console.log(`Windows release check: PASS (${signatureLabel})`);
console.log(`Publisher: ${publisherLabel}`);
console.log(`SHA-256: ${sha256}`);
console.log(`Share directory: ${sharePath}`);
