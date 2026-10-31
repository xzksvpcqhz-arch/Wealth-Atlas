const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const codes = require("./auth-diagnostic-codes.json");
const { createAuthTrace } = require("./auth-trace.cjs");
const { createDiagnosticVisibilityProbe } = require("./diagnostic-visibility.cjs");

/** Candidate-only technical sidecar, OUTSIDE any financial profile. It remains
 * usable if the profile log cannot be written. No payload/identity is accepted. */
function createCandidateDiagnostics(version, directory, write = fs.writeFileSync, mode = "manual-candidate", bootId = randomUUID()) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version)) return () => false;
  if (!["manual-candidate", "isolated-qa"].includes(mode)) return () => false;
  if (typeof bootId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId)) return () => false;
  const report = { appVersion: version, bootId, startedAt: new Date().toISOString(), mode, codes: [] };
  const file = path.join(directory, mode === "isolated-qa" ? "candidate-qa-startup-diagnostic.json" : "candidate-startup-diagnostic.json");
  return (code) => {
    if (typeof code !== "string" || !Object.hasOwn(codes, code)) return false;
    if (!report.codes.includes(code)) report.codes.push(code);
    try { write(file, JSON.stringify(report, null, 2) + "\n", "utf8"); return true; }
    catch { return false; } // Diagnostics can never block startup or data access.
  };
}

let recordCandidateDiagnostic = () => false;
let runCandidateVisibilityProbe = () => false;
function enableCandidateDiagnostics(version, executable, mode = "manual-candidate", visibility = {}) {
  const directory = path.dirname(executable);
  const bootId = randomUUID();
  const record = createCandidateDiagnostics(version, directory, fs.writeFileSync, mode, bootId);
  const trace = createAuthTrace({ version, directory, mode, bootId });
  recordCandidateDiagnostic = code => {
    if (typeof code !== "string" || !Object.hasOwn(codes, code)) return false;
    const result = record(code);
    if (!trace(code)) record("AUTH_TRACE_WRITE_FAILED");
    return result;
  };
  recordCandidateDiagnostic("AUTH_RUNTIME_STARTED");
  // Only the candidate bootstrap supplies a build-specific ID and pinned root.
  // Formal releases, and older candidate metadata, remain completely inactive.
  runCandidateVisibilityProbe = createDiagnosticVisibilityProbe({ version, mode,
    probeId: visibility.probeId, expectedRoot: visibility.expectedRoot, record: recordCandidateDiagnostic });
}
module.exports = { createCandidateDiagnostics, enableCandidateDiagnostics,
  recordCandidateDiagnostic: (code) => recordCandidateDiagnostic(code),
  runCandidateVisibilityProbe: root => runCandidateVisibilityProbe(root) };
