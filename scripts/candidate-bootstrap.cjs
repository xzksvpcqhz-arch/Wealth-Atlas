/* This entry point is copied ONLY into the separately staged candidate package.
 * The production package keeps desktop/main.cjs as its unchanged entry point. */
const { app } = require("electron");
const path = require("node:path");
const metadata = require("../package.json");
if (metadata.wealthAtlasCandidate !== "cloud-sync-test" || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(metadata.version)) {
  throw new Error("Candidate metadata is missing; no profile was opened.");
}
// Explicitly approved release metadata only, never an environment/CLI path.
// This selects the SAME existing candidate directory; no files are moved or
// copied. QA always stays below the CURRENT version's new UUID directory.
const profileVersion = metadata.wealthAtlasCandidateProfileVersion ?? metadata.version;
const applicationMatch = metadata.version.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
const profileMatch = typeof profileVersion === "string" && profileVersion.match(/^(\d+\.\d+\.\d+)-rc\.(\d+)$/);
if (!profileMatch || profileMatch[1] !== applicationMatch[1]
  || !Number.isSafeInteger(Number(profileMatch[2])) || Number(profileMatch[2]) > Number(applicationMatch[2])) {
  throw new Error("Invalid candidate profile metadata; no profile was opened.");
}
const qaSession = process.argv.find((argument) => argument.startsWith("--candidate-qa-session="))?.split("=")[1];
if (qaSession && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(qaSession)) {
  throw new Error("Invalid candidate QA session; no profile was opened.");
}
const candidateRoot = path.join(app.getPath("appData"), "Wealth Atlas Sync Candidate", qaSession ? metadata.version : profileVersion,
  ...(qaSession ? ["isolated-qa", qaSession] : []));
// Ignore inherited profile overrides. Double-clicking the executable itself is
// just as isolated as using a launcher; it can never select the production root.
process.env.WEALTH_ATLAS_TEST_PROFILE = candidateRoot;
app.setName("Wealth Atlas Sync Candidate");
app.setPath("userData", candidateRoot);
app.setPath("sessionData", candidateRoot);
// Only a new isolated QA UUID may wait on about:blank. An ordinary launch can
// never inherit this flag or accidentally open a different profile.
process.env.WEALTH_ATLAS_CANDIDATE_FIRST_DOCUMENT = qaSession && process.argv.includes("--candidate-qa-first-document") ? qaSession : "";
require("../desktop/candidate-diagnostics.cjs").enableCandidateDiagnostics(metadata.version, process.execPath, qaSession ? "isolated-qa" : "manual-candidate", {
  probeId: metadata.wealthAtlasCandidateVisibilityProbeId, expectedRoot: candidateRoot,
});
require("./main.cjs");
