import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Requiring this fixture in ordinary Node only reads its group declarations.
const { GROUPS } = createRequire(import.meta.url)("./fixtures/named-layouts-ui.cjs");

test("actual named-layout React UI and hooks in isolated Electron", { timeout: 175_000 }, async t => {
  const binary = process.platform === "win32" ? "electron.exe"
    : process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  const env = {};
  // Explicit OS-only allowlist: no inherited auth, NODE_OPTIONS, Electron mode,
  // app config, credentials, HOME/APPDATA, npm config or project environment.
  for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "PATH", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const runId = randomUUID();
  const relative = `work/named-layouts-ui/${runId}`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.join(root, "node_modules/electron/dist", binary), ["--disable-gpu",
      path.join(root, "tests/fixtures/named-layouts-ui.cjs"), `--qa-run=${runId}`],
    { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = chunk => { output = (output + chunk.toString()).slice(-20_000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Synthetic UI harness timed out; evidence: ${relative}`)); }, 160_000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Could not launch repository Electron for synthetic UI QA")); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
  let report;
  try { report = JSON.parse(readFileSync(path.join(root, relative, "result.json"), "utf8")); }
  catch {
    const failure = result.output.match(/NAMED_LAYOUTS_UI_FAIL[^\r\n]*/)?.[0]
      ?.replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, "[local path]");
    assert.fail(failure ?? `Electron exited ${result.code} without a result file; evidence: ${relative}`);
  }
  const expected = [...GROUPS.offscreen, ...GROUPS.native];
  assert.deepEqual(report.groups.map(group => group.name), expected, "Every meaningful declared group ran; none skipped");
  assert.equal(report.version, 1);
  assert.equal(report.productionDataAccessed, false);
  assert.equal(report.realBackendRequests, 0); assert.equal(report.blockedRequests, 0);
  assert.equal(report.networkAttempts, 0); assert.equal(report.authCalls, 0);
  assert.ok(report.transportRequests > 0, "Actual sync and transport exercised the fake client");
  assert.equal(Object.keys(report.sourceHashes).length, 11, "Both hooks, component, models, sync, transport and CSS were loaded");
  console.log(`NAMED_LAYOUTS_UI_RESULT ${JSON.stringify({ passed: report.passed, failed: report.failed,
    groups: report.groups.length, assertions: report.assertions, transportRequests: report.transportRequests,
    captures: report.captures.length, evidence: `${relative}/result.json` })}`);
  for (const group of report.groups) await t.test(group.name, () => {
    assert.ok(group.assertions >= 8, "Group performed meaningful assertions plus isolation checks");
    assert.equal(group.ok, true, group.error ?? "Group did not pass");
  });
  assert.equal(report.captures.length, 8, "All four actual widths and their dialogs were captured");
  assert.equal(report.passed + report.failed, expected.length);
  assert.equal(report.failed, 0, "Implementation failures remain failures, not skips or expected passes");
  assert.equal(report.ok, true); assert.equal(result.code, 0);
});
