import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("restore quarantine: real isolated IndexedDB transactions, restart and two-window Web Locks; synthetic data only", { timeout: 60000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binary = process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  const env = {};
  for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const report = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist", binary), ["--disable-gpu", path.join(root, "scripts/restore-isolation-test.cjs")], {
      cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-20000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated restore test timed out")); }, 55000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const match = output.match(/RESTORE_ISOLATION_PASS (\{[^\r\n]+\})/);
      if (code !== 0 || !match) { reject(new Error(output.match(/RESTORE_ISOLATION_FAIL[^\r\n]*/)?.[0] ?? `Isolated restore process exited ${code}`)); return; }
      resolve(JSON.parse(match[1]));
    });
  });
  assert.equal(report.realBackendRequests, 0);
  assert.equal(report.productionDataAccessed, false);
  assert.equal(report.twoIndependentWindows, true);
  assert.ok(report.checks.length >= 20);
  console.log(`RESTORE_ISOLATION_PASS ${JSON.stringify(report)}`);
});
