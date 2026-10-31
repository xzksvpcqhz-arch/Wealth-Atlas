import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const electronBinary = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const profilePath = path.join(projectRoot, "work", "desktop-test-profiles", randomUUID());
const testVaultPath = path.join(profilePath, "fake-obsidian-vault");
const phases = ["main-startup-failure", "empty", "startup-diagnostics", "main-error-hooks", "localstorage-unavailable", "obsidian-disconnected", "obsidian-disconnect-failure", "obsidian-disconnect-success", "seed-empty-object", "verify-startup-empty-object", "seed-partial-snapshot", "verify-startup-partial-snapshot", "seed-legacy-snapshot", "migration-failure", "verify-legacy-migration", "asset-audit", "diagnostics", "diagnostic-browser-clipboard", "diagnostic-ipc-clipboard", "diagnostic-ipc-failure", "diagnostic-save-failure", "error-boundary", "renderer-process-crash", "layout", "vault-bridge", "seed", "indexeddb-open-failure", "indexeddb-blocked", "indexeddb-versionchange", "indexeddb-read-failure", "verify", "edit", "verify-edit", "soft-delete", "verify-soft-delete", "restore", "verify-restore", "permanent-delete", "verify-permanent-delete"];

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    // The layout fixtures use transparent, non-taskbar windows. Keep Chromium
    // rendering them while occluded so viewport changes and rAF focus effects
    // are observed, not a stale frame. These switches are test-launcher ONLY;
    // all existing layout/focus assertions and production defaults stay intact.
    const browserArgs = ["--disable-gpu", "--disable-gpu-compositing", "--disable-software-rasterizer", "--in-process-gpu",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"];
    if (phase === "localstorage-unavailable") browserArgs.push("--disable-local-storage");
    const child = spawn(electronBinary, [...browserArgs, ".", `--desktop-smoke=${phase}`], {
      cwd: projectRoot,
      env: { ...process.env, WEALTH_ATLAS_TEST_PROFILE: profilePath, ...(["vault-bridge", "obsidian-disconnect-failure", "obsidian-disconnect-success"].includes(phase) ? { WEALTH_ATLAS_TEST_VAULT: testVaultPath } : {}), WEALTH_ATLAS_DESKTOP_SMOKE: phase },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      process.stdout.write(output);
      if (code === 0 && output.includes("WEALTH_ATLAS_SMOKE")) resolve();
      else reject(new Error(`Desktop smoke phase ${phase} failed with exit code ${code}.`));
    });
  });
}

for (const phase of [...phases, "account-isolation"]) await runPhase(phase);
const rendererLog = await readFile(path.join(profilePath, "logs", "renderer.log"), "utf8");
const mainLog = await readFile(path.join(profilePath, "logs", "main.log"), "utf8");
const startup = JSON.parse(await readFile(path.join(profilePath, "logs", "startup.json"), "utf8"));
const rendererLogStat = await stat(path.join(profilePath, "logs", "renderer.log"));
const mainLogStat = await stat(path.join(profilePath, "logs", "main.log"));
if (rendererLogStat.size > 512 * 1024) throw new Error("Renderer diagnostic log exceeded its size limit.");
if (mainLogStat.size > 512 * 1024) throw new Error("Main diagnostic log exceeded its size limit.");
for (const privateTestValue of ["desktop-test-account", "desktop-test-transaction", "desktop-test-budget", "desktop-test-goal"]) {
  if (rendererLog.includes(privateTestValue) || mainLog.includes(privateTestValue) || JSON.stringify(startup).includes(privateTestValue)) throw new Error("Diagnostic logs contain seeded finance data.");
}
for (const expectedEvent of ["process-start", "startup-failed", "app-ready", "static-protocol-registered", "browser-window-created", "load-url-start", "load-url-finished", "uncaught-exception", "unhandled-rejection", "render-process-gone"]) {
  if (!mainLog.includes(`\"event\":\"${expectedEvent}\"`)) throw new Error(`Missing main diagnostic event: ${expectedEvent}.`);
}
if (!rendererLog.includes('"event":"renderer-diagnostic"')) throw new Error("Missing renderer diagnostic event.");
if (!startup.appVersion || !startup.lastEvent) throw new Error("startup.json is incomplete.");
console.log(`Desktop persistence test profile (isolated, not packaged): ${profilePath}`);
