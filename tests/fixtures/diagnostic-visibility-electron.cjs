/* Main-process only: fresh synthetic temp root, no window/auth/database/network.
 * Parent supplies a new owned root; repeat mode MUST preserve the same marker. */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { enableCandidateDiagnostics, runCandidateVisibilityProbe } = require("../../desktop/candidate-diagnostics.cjs");
const { PROBE_TEXT } = require("../../desktop/diagnostic-visibility.cjs");
const profileArg = process.argv.find(arg => arg.startsWith("--visibility-qa-root="));
const profile = path.resolve(profileArg?.slice("--visibility-qa-root=".length) ?? ".");
const repeat = process.argv.includes("--repeat");
const probeId = "88888888-8888-4888-8888-888888888888";
const version = "1.7.5-rc.13"; // Synthetic candidate, not an installed-release claim.
assert.equal(path.dirname(profile).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.match(path.basename(profile), /^wealth-atlas-visibility-qa-[A-Za-z0-9]{6}$/);
assert.equal(fs.lstatSync(profile).isDirectory(), true);
assert.equal(fs.lstatSync(profile).isSymbolicLink(), false);
assert.equal(fs.realpathSync(profile).toLowerCase(), profile.toLowerCase());
assert.equal(fs.readFileSync(path.join(profile, "synthetic-qa-only.txt"), "utf8"), "WEALTH_ATLAS_SYNTHETIC_VISIBILITY_ONLY");
const logs = path.join(profile, "logs"), technical = path.join(profile, "technical");
const marker = path.join(logs, `diagnostic-visibility-${probeId}.txt`);
if (!repeat) { assert.equal(fs.existsSync(logs), false); fs.mkdirSync(logs); fs.mkdirSync(technical); }
const previous = repeat ? fs.statSync(marker) : null;
app.setPath("userData", profile); app.setPath("sessionData", profile);
enableCandidateDiagnostics(version, path.join(technical, "synthetic.exe"), "isolated-qa", { probeId, expectedRoot: profile });

app.whenReady().then(() => {
  assert.equal(runCandidateVisibilityProbe(app.getPath("userData")), !repeat);
  assert.equal(fs.readFileSync(marker, "utf8"), PROBE_TEXT); // Own exact newly created marker only.
  const report = JSON.parse(fs.readFileSync(path.join(technical, "candidate-qa-startup-diagnostic.json"), "utf8"));
  if (repeat) {
    const after = fs.statSync(marker);
    assert.equal(after.ino, previous.ino); assert.equal(after.mtimeMs, previous.mtimeMs);
    assert.ok(report.codes.includes("VISIBILITY_PROBE_FILE_EXISTS"));
    assert.ok(!report.codes.includes("VISIBILITY_PROBE_READBACK_CONFIRMED"));
  } else {
    assert.ok(report.codes.includes("VISIBILITY_PROBE_WRITE_CONFIRMED"));
    assert.ok(report.codes.includes("VISIBILITY_PROBE_READBACK_CONFIRMED"));
  }
  console.log("VISIBILITY_NATIVE_RESULT " + JSON.stringify({ pass: true, mode: repeat ? "repeat" : "seed",
    realProfileAccessed: false, financialDatabaseOpened: false, networkUsed: false, devtoolsUsed: false }));
  app.quit();
}).catch(() => {
  console.log('VISIBILITY_NATIVE_RESULT {"pass":false,"failureCode":"SYNTH_VISIBILITY_FAILED"}'); app.exit(1);
});
