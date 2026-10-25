import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";
const { setupAutoUpdates, PUBLIC_FEED } = createRequire(import.meta.url)("../desktop/updater.cjs");

class FakeUpdater extends EventEmitter {
  calls = 0;
  quits = 0;
  setFeedURL(feed) { this.feed = feed; }
  quitAndInstall() { this.quits++; }
  async checkForUpdates() { this.calls++; this.emit("update-not-available", { version: "1.7.3" }); return null; }
}
const options = (updater, extra = {}) => ({ updater, isPackaged: true, platform: "win32", ...extra });

test("production uses the public GitHub stable feed without credentials or downgrade", async () => {
  const updater = new FakeUpdater();
  updater.requestHeaders = { Authorization: "synthetic-secret" };
  const control = setupAutoUpdates(options(updater));
  await control.check();
  assert.deepEqual(updater.feed, PUBLIC_FEED);
  assert.equal(updater.requestHeaders, null);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.calls, 1);
});
test("download completion never quits the app or duplicates installation", async () => {
  const updater = new FakeUpdater();
  const control = setupAutoUpdates(options(updater));
  await control.check();
  updater.emit("update-downloaded", { version: "1.7.4" });
  updater.emit("update-downloaded", { version: "1.7.4" });
  assert.equal(control.getState().status, "downloaded");
  await control.check();
  assert.equal(updater.quits, 0);
  assert.equal(updater.calls, 1);
});
test("concurrent checks and repeated setup share one check and one event handler", async () => {
  const updater = new FakeUpdater();
  let finish;
  updater.checkForUpdates = () => { updater.calls++; return new Promise((resolve) => { finish = resolve; }); };
  const first = setupAutoUpdates(options(updater));
  const second = setupAutoUpdates(options(updater));
  assert.equal(first, second);
  const pending = first.check();
  assert.equal(first.check(), pending);
  await Promise.resolve(); finish(null); await pending;
  assert.equal(updater.calls, 1);
  assert.equal(updater.listenerCount("update-downloaded"), 1);
});
test("offline failures retry after the throttle and never expose upstream private text", async () => {
  const updater = new FakeUpdater();
  let clock = 0;
  const logs = [];
  updater.checkForUpdates = async () => { updater.calls++; throw Object.assign(new Error("synthetic-secret / synthetic-financial-text"), { code: "ENOTFOUND" }); };
  const control = setupAutoUpdates(options(updater, { now: () => clock, log: (...args) => logs.push(args) }));
  await control.check(); await control.check();
  assert.equal(updater.calls, 1);
  assert.equal(control.getState().status, "error");
  clock = 60001;
  updater.checkForUpdates = async () => { updater.calls++; updater.emit("update-not-available"); return null; };
  await control.check();
  assert.equal(updater.calls, 2);
  assert.equal(control.getState().status, "up-to-date");
  assert.equal(JSON.stringify(logs).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(logs).includes("financial-text"), false);
});
test("download rejection and setup failure are handled without crashing startup", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error("synthetic-download-failure")) });
  const control = setupAutoUpdates(options(updater));
  assert.equal((await control.check()).status, "error");
  const broken = new FakeUpdater();
  broken.setFeedURL = () => { throw new Error("synthetic-config-failure"); };
  assert.equal(setupAutoUpdates(options(broken)).getState().status, "error");
});
test("development, isolated profiles, unsupported platforms and unavailable updater never use the network", async () => {
  for (const extra of [{ isPackaged: false }, { isolated: true }, { platform: "linux" }]) {
    const updater = new FakeUpdater();
    assert.equal((await setupAutoUpdates(options(updater, extra)).check()).status, "disabled");
    assert.equal(updater.calls, 0);
  }
  assert.equal((await setupAutoUpdates(options(null)).check()).status, "disabled");
});
