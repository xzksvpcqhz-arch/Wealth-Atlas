import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Arch, Platform, build } from "electron-builder";
import packageJson from "../package.json" with { type: "json" };
import { assertCloudBuildConfigured, prepareGithubPublish, publishCheckedRelease } from "./github-release.mjs";
import { stageRuntimeApplication } from "./runtime-dependencies.mjs";
import { randomUUID } from "node:crypto";

const projectRoot = process.cwd();
const localCandidate = process.env.WEALTH_ATLAS_LOCAL_CANDIDATE === "1";
if (localCandidate && process.env.WEALTH_ATLAS_PUBLISH === "1") throw new Error("Local installer candidates cannot be published.");
if (!localCandidate && (process.env.WEALTH_ATLAS_RELEASE_SOURCE_ROOT || process.env.WEALTH_ATLAS_RELEASE_DIR)) throw new Error("Source/output overrides require explicit local-candidate mode; publishing overrides are forbidden.");
assertCloudBuildConfigured(process.env);

// Public update feeds do not require a token inside the application.
// Refuse a leftover secret without reading or deleting it.
const embedTokenFile = path.join(projectRoot, "desktop", "update-token.json");
if (process.env.WEALTH_ATLAS_EMBED_TOKEN === "1" || existsSync(embedTokenFile)) throw new Error("Token embedding is disabled. Remove any leftover token file manually before building; it has not been read or deleted.");
const publishContext = process.env.WEALTH_ATLAS_PUBLISH === "1" ? await prepareGithubPublish(projectRoot, packageJson) : null;

const certificatePath = process.env.WINDOWS_CERTIFICATE_PATH?.trim() ?? "";
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD ?? "";
const timestampUrl = process.env.WINDOWS_TIMESTAMP_URL?.trim() ?? "";
const publisherName = process.env.WINDOWS_PUBLISHER_NAME?.trim() ?? "";
const signingValues = {
  WINDOWS_CERTIFICATE_PATH: certificatePath,
  WINDOWS_CERTIFICATE_PASSWORD: certificatePassword,
  WINDOWS_TIMESTAMP_URL: timestampUrl,
  WINDOWS_PUBLISHER_NAME: publisherName,
};
const suppliedCount = Object.values(signingValues).filter(Boolean).length;
const signedRelease = suppliedCount > 0;

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed with exit code ${code}.`)));
  });
}

if (signedRelease && suppliedCount !== Object.keys(signingValues).length) {
  const missing = Object.entries(signingValues).filter(([, value]) => !value).map(([name]) => name);
  throw new Error(`Signing configuration is incomplete. Missing: ${missing.join(", ")}.`);
}

if (signedRelease) {
  if (!path.isAbsolute(certificatePath) || !existsSync(certificatePath)) {
    throw new Error("WINDOWS_CERTIFICATE_PATH must point to an existing absolute PFX/P12 file.");
  }
  if (!/\.(pfx|p12)$/i.test(certificatePath)) {
    throw new Error("WINDOWS_CERTIFICATE_PATH must use a .pfx or .p12 certificate container.");
  }
  const parsedTimestamp = new URL(timestampUrl);
  if (!/^https?:$/.test(parsedTimestamp.protocol)) {
    throw new Error("WINDOWS_TIMESTAMP_URL must be an HTTP(S) RFC 3161 timestamp URL.");
  }
}

console.log(`Preparing Wealth Atlas ${packageJson.version} Windows release: ${signedRelease ? "SIGNED" : "UNSIGNED"}.`);
if (!signedRelease) {
  console.log("No formal certificate configuration was supplied. The result will remain explicitly UNSIGNED.");
}

await run(process.execPath, ["scripts/desktop-build.mjs"]);

const buildConfig = structuredClone(packageJson.build);
const releaseDirectory = localCandidate && process.env.WEALTH_ATLAS_RELEASE_DIR
  ? path.resolve(process.env.WEALTH_ATLAS_RELEASE_DIR) : path.join("desktop-dist", `v${packageJson.version}`);
if (existsSync(path.join(releaseDirectory, "Wealth-Atlas-Setup.exe")) || existsSync(path.join(releaseDirectory, "win-unpacked"))) {
  throw new Error("Release output already exists; preserve it and choose a new local candidate directory.");
}
buildConfig.directories = { ...buildConfig.directories, output: releaseDirectory };
{
  // Fresh formal builds also need a physical runtime dependency closure.
  const runtimeApp = path.join(projectRoot, "work", "release-runtime", randomUUID(), "app");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(runtimeApp), { recursive: true });
  await stageRuntimeApplication(projectRoot, path.resolve(process.env.WEALTH_ATLAS_RELEASE_SOURCE_ROOT || projectRoot), runtimeApp, { localCandidate });
  buildConfig.directories.app = runtimeApp;
  // Explicit file set: do not rely on the package-manager collector to follow
  // the build dependency link or infer the nested, physical runtime closure.
  buildConfig.files = [...(buildConfig.files ?? []), { from: path.join(runtimeApp, "node_modules"), to: "node_modules", filter: ["**/*"] }];
}
buildConfig.electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
buildConfig.win = {
  ...buildConfig.win,
  signExecutable: signedRelease,
  signtoolOptions: {
    ...(buildConfig.win.signtoolOptions ?? {}),
    ...(signedRelease ? {
      rfc3161TimeStampServer: timestampUrl,
      publisherName,
    } : {}),
  },
};

const signingEnv = signedRelease ? {
  WIN_CSC_LINK: certificatePath,
  WIN_CSC_KEY_PASSWORD: certificatePassword,
  CSC_LINK: certificatePath,
  CSC_KEY_PASSWORD: certificatePassword,
  CSC_IDENTITY_AUTO_DISCOVERY: "true",
} : {
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};

Object.assign(process.env, signingEnv);
await build({
  targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
  config: buildConfig,
  // Build and validate locally before any remote write.
  publish: "never",
});

await run(process.execPath, ["scripts/windows-release-check.mjs"], {
  WEALTH_ATLAS_RELEASE_DIR: releaseDirectory,
  WEALTH_ATLAS_RELEASE_SIGNING: signedRelease ? "SIGNED" : "UNSIGNED",
  WINDOWS_PUBLISHER_NAME: signedRelease ? publisherName : "",
});
// Test the exact signed/unsigned bytes just built, before any remote write.
await run(process.execPath, ["scripts/windows-installed-release-test.mjs"], {
  WEALTH_ATLAS_RELEASE_DIR: releaseDirectory,
});
await run(process.execPath, ["scripts/windows-release-check.mjs"], {
  WEALTH_ATLAS_RELEASE_DIR: releaseDirectory,
  WEALTH_ATLAS_RELEASE_SIGNING: signedRelease ? "SIGNED" : "UNSIGNED",
  WINDOWS_PUBLISHER_NAME: signedRelease ? publisherName : "",
});
if (publishContext) {
  const rechecked = await prepareGithubPublish(projectRoot, packageJson);
  if (rechecked.head !== publishContext.head) throw new Error("Publish blocked: source changed during the build.");
  await publishCheckedRelease(rechecked, path.resolve(projectRoot, releaseDirectory), packageJson.version);
}
