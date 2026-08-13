import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const electronBinary = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const profilePath = path.join(projectRoot, "work", "desktop-test-profiles", randomUUID());
const testVaultPath = path.join(profilePath, "fake-obsidian-vault");
const phases = ["empty", "layout", "vault-bridge", "seed", "verify", "edit", "verify-edit", "soft-delete", "verify-soft-delete", "restore", "verify-restore", "permanent-delete", "verify-permanent-delete"];

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, ["--disable-gpu", "--disable-gpu-compositing", "--disable-software-rasterizer", "--in-process-gpu", ".", `--desktop-smoke=${phase}`], {
      cwd: projectRoot,
      env: { ...process.env, WEALTH_ATLAS_TEST_PROFILE: profilePath, WEALTH_ATLAS_TEST_VAULT: testVaultPath, WEALTH_ATLAS_DESKTOP_SMOKE: phase },
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

for (const phase of phases) await runPhase(phase);
console.log(`Desktop persistence test profile (isolated, not packaged): ${profilePath}`);
