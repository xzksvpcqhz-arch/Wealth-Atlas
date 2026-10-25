const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { randomUUID, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");

async function electronTest() {
  const { app } = require("electron");
  const profile = process.argv.find((argument) => argument.startsWith("--profile="))?.slice(10);
  assert.ok(profile && profile.startsWith(path.join(root, "work", "updater-feed-tests") + path.sep));
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  await app.whenReady();
  const { NsisUpdater } = require("electron-updater");
  const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
  const { setupAutoUpdates, PUBLIC_FEED } = require("../desktop/updater.cjs");
  if (process.argv.includes("--public")) {
    const releaseVersion = require("../package.json").version;
    const releaseRoot = path.join(root, "desktop-dist", `v${releaseVersion}`);
    const report = JSON.parse(fs.readFileSync(path.join(releaseRoot, "release-check.json"), "utf8"));
    const adapter = {
      version: "1.7.3", name: "WealthAtlasPublicUpdateFixture", isPackaged: true,
      appUpdateConfigPath: path.join(releaseRoot, "win-unpacked", "resources", "app-update.yml"),
      userDataPath: profile, baseCachePath: profile, whenReady: async () => {}, onQuit: () => {},
      quit: () => { throw new Error("Public update test must not quit an installed application"); },
      relaunch: () => { throw new Error("Public update test must not relaunch an installed application"); },
    };
    const updater = new NsisUpdater(null, adapter);
    updater.httpExecutor = new ElectronHttpExecutor(null);
    const createRequest = updater.httpExecutor.createRequest.bind(updater.httpExecutor);
    let requests = 0;
    updater.httpExecutor.createRequest = (options, callback) => {
      assert.ok(!Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "authorization"), "Public update requested an authorization header");
      requests++; return createRequest(options, callback);
    };
    updater.disableDifferentialDownload = true;
    updater.doInstall = () => { throw new Error("Actual installer execution is forbidden in this test"); };
    const control = setupAutoUpdates({ updater, isPackaged: true, platform: "win32" });
    const result = await control.check();
    assert.equal(result.status, "downloaded", "Public update did not download: " + (result.code || result.status));
    assert.equal(result.version, releaseVersion);
    assert.equal(createHash("sha256").update(fs.readFileSync(updater.installerPath)).digest("hex").toUpperCase(), report.sha256.toUpperCase());
    console.log("UPDATER_PUBLIC_TEST " + JSON.stringify({ pass: true, version: result.version, sha256MatchesPublishedBuild: true, publicRequests: requests, actualInstallerExecuted: false, noCredentialsTransmitted: true }));
    app.quit(); return;
  }
  const payload = Buffer.from("MZ - synthetic non-executable update fixture, never installed");
  let scenario;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: new URL(request.url, "http://127.0.0.1").pathname, hasAuthorization: Boolean(request.headers.authorization) });
    if (request.url.startsWith("/latest.yml")) {
      const sha512 = createHash("sha512").update(payload).digest("base64");
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(`version: ${scenario.version}\npath: Wealth-Atlas-Setup.exe\nsha512: ${sha512}\nfiles:\n  - url: Wealth-Atlas-Setup.exe\n    sha512: ${sha512}\n    size: ${payload.length}\nreleaseDate: '2026-10-25T00:00:00.000Z'\n`);
    } else if (request.url.startsWith("/Wealth-Atlas-Setup.exe")) {
      const bytes = scenario.corrupt ? Buffer.from("MZ - tampered synthetic fixture") : payload;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length }); response.end(bytes);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const feedUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    const results = [];
    for (const entry of [
      { name: "new-version", version: "1.7.4", expected: "downloaded" },
      { name: "same-version", version: "1.7.3", expected: "up-to-date" },
      { name: "older-version", version: "1.7.2", expected: "up-to-date" },
      { name: "checksum-failure", version: "1.7.4", corrupt: true, expected: "error" },
    ]) {
      scenario = entry;
      const folder = path.join(profile, entry.name);
      fs.mkdirSync(folder, { recursive: true });
      const config = path.join(folder, "app-update.yml");
      fs.writeFileSync(config, "provider: github\nowner: xzksvpcqhz-arch\nrepo: Wealth-Atlas\nupdaterCacheDirName: synthetic-update-cache\n");
      const quitHandlers = [];
      const adapter = {
        version: "1.7.3", name: "WealthAtlasUpdaterFixture", isPackaged: true,
        appUpdateConfigPath: config, userDataPath: folder, baseCachePath: folder,
        whenReady: async () => {}, onQuit: (callback) => quitHandlers.push(callback),
        quit: () => { throw new Error("Test must never quit a financial application"); },
        relaunch: () => { throw new Error("Test must never relaunch an application"); },
      };
      const updater = new NsisUpdater(null, adapter);
      updater.httpExecutor = new ElectronHttpExecutor(null);
      updater.disableDifferentialDownload = true;
      let installs = 0;
      // Hard block actual installation, including an unexpected library call.
      updater.doInstall = () => { installs++; return true; };
      const configureFeed = updater.setFeedURL.bind(updater);
      updater.setFeedURL = (publicFeed) => { assert.deepEqual(publicFeed, PUBLIC_FEED); configureFeed({ provider: "generic", url: feedUrl }); };
      const control = setupAutoUpdates({ updater, isPackaged: true, platform: "win32" });
      const result = await control.check();
      assert.equal(result.status, entry.expected, entry.name);
      assert.equal(installs, 0, "Download completion triggered installation");
      if (entry.expected === "downloaded") {
        assert.deepEqual(fs.readFileSync(updater.installerPath), payload);
        quitHandlers.forEach((callback) => callback(1));
        assert.equal(installs, 0, "Abnormal exit should not install");
        quitHandlers.forEach((callback) => callback(0));
        quitHandlers.forEach((callback) => callback(0));
        assert.equal(installs, 1, "Normal exit must schedule installation exactly once");
      }
      results.push({ scenario: entry.name, status: result.status, actualInstallerExecuted: false });
    }
    assert.ok(requests.length > 4 && requests.every((request) => !request.hasAuthorization));
    console.log("UPDATER_FEED_TEST " + JSON.stringify({ pass: true, transport: "loopback HTTP", updater: "real electron-updater NSIS", results, noCredentialsTransmitted: true }));
  } finally { await new Promise((resolve) => server.close(resolve)); app.quit(); }
}

async function run() {
  if (process.versions.electron) return electronTest();
  const profile = path.join(root, "work", "updater-feed-tests", randomUUID());
  await new Promise((resolve, reject) => {
    const publicMode = process.argv.includes("--public");
    const child = spawn(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [__filename, `--profile=${profile}`, ...(publicMode ? ["--public"] : []), "--disable-gpu"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated update test timed out")); }, publicMode ? 240000 : 45000);
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); process.stdout.write(output); code === 0 && output.includes('"pass":true') ? resolve() : reject(new Error("Isolated update test failed")); });
  });
}
run().catch((error) => { console.error(error.message); if (process.versions.electron) require("electron").app.exit(1); else process.exitCode = 1; });
