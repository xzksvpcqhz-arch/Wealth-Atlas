import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Arch, Platform, build } from "electron-builder";
import packageJson from "../package.json" with { type: "json" };

const projectRoot = process.cwd();
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
const releaseDirectory = path.join("desktop-dist", `v${packageJson.version}`);
buildConfig.directories = { ...buildConfig.directories, output: releaseDirectory };
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
  // 设为 "always" 会上传到 GitHub Releases（需 GH_TOKEN 环境变量），默认只本地构建 + 生成 latest.yml
  publish: process.env.WEALTH_ATLAS_PUBLISH === "1" ? "always" : "never",
});

await run(process.execPath, ["scripts/windows-release-check.mjs"], {
  WEALTH_ATLAS_RELEASE_DIR: releaseDirectory,
  WEALTH_ATLAS_RELEASE_SIGNING: signedRelease ? "SIGNED" : "UNSIGNED",
  WINDOWS_PUBLISHER_NAME: signedRelease ? publisherName : "",
});
