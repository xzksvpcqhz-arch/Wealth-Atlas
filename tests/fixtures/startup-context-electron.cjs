/* Native Electron API check only. New temporary UUID profile, no BrowserWindow,
 * Auth SDK, hosted request, real profile, financial store or existing backup. */
const { app, session } = require("electron");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStartupDiagnostics } = require("../../desktop/startup-diagnostics.cjs");

const root = mkdtempSync(path.join(os.tmpdir(), "wealth-atlas-context-qa-"));
const mismatch = process.argv.includes("--session-mismatch");
const sessionRoot = mismatch ? path.join(root, "different-session") : root;
mkdirSync(sessionRoot, { recursive: true });
app.setPath("userData", root);
app.setPath("sessionData", sessionRoot);
app.disableHardwareAcceleration();
const codes = [];
const diagnostics = createStartupDiagnostics({ expectedRoot: root, record: code => codes.push(code),
  getUserData: () => app.getPath("userData"), getSessionData: () => app.getPath("sessionData"),
  getStoragePath: () => session.defaultSession.storagePath });
const beforeReady = diagnostics.checkContext("before-ready");
app.whenReady().then(() => {
  const ready = diagnostics.checkContext("ready");
  const expected = mismatch
    ? ["PROFILE_SESSION_ROOT_MISMATCH", "PROFILE_STORAGE_ROOT_MISMATCH"]
    : ["PROFILE_USER_ROOT_MATCH", "PROFILE_SESSION_ROOT_MATCH", "PROFILE_STORAGE_ROOT_MATCH"];
  const pass = beforeReady === !mismatch && ready === !mismatch && expected.every(code => codes.includes(code));
  console.log("STARTUP_CONTEXT_NATIVE_RESULT " + JSON.stringify({ pass, scenario: mismatch ? "SESSION_MISMATCH" : "MATCHING_ROOTS",
    codes: [...new Set(codes)], financialStoresOpened: false, realProfileAccessed: false }));
  app.exit(pass ? 0 : 1);
}).catch(() => {
  console.error("STARTUP_CONTEXT_NATIVE_RESULT " + JSON.stringify({ pass: false, code: "NATIVE_QA_FAILED" }));
  app.exit(1);
});
