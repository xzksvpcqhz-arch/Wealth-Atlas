import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("actual display preferences hook in isolated, network-blocked Electron", { timeout: 50_000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const binary = process.platform === "win32" ? "electron.exe"
    : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  // Do not forward credentials or app configuration to the synthetic process.
  const env = {};
  for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist", binary), [
      "--disable-gpu", path.join(root, "tests/fixtures/display-preferences-hook.cjs"),
    ], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-16_384); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Isolated display hook test exceeded time limit"));
    }, 40_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const failure = output.match(/DISPLAY_PREFERENCES_HOOK_FAIL[^\r\n]*/)?.[0];
      if (code !== 0) { reject(new Error(failure ?? `Electron display hook harness exited ${code}`)); return; }
      const match = output.match(/DISPLAY_PREFERENCES_HOOK_PASS (\{[^\r\n]+\})/);
      if (!match) { reject(new Error("Electron did not report display hook results")); return; }
      try { resolve(JSON.parse(match[1])); } catch { reject(new Error("Invalid display hook result")); }
    });
  });
  assert.equal(result.checks, 17);
  assert.equal(result.profile, "isolated");
  assert.equal(result.realBackendRequests, 0);
  assert.equal(result.authCalls, 0);
  assert.ok(result.transportRequests > 0, "Production sync/transport ran against the fake client");
  console.log(`DISPLAY_PREFERENCES_HOOK_PASS ${JSON.stringify(result)}`);
});
