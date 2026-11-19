import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
const require = createRequire(import.meta.url);
const { CHANNELS, RELEASES_URL, serializeUpdateState, trustedUpdateSender, registerUpdateIpc } = require("../desktop/update-ipc.cjs");
const { setupAutoUpdates } = require("../desktop/updater.cjs");
const ts = require("typescript");
const module = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/update-center.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module, exports: module.exports, Set, Object, Number, Promise, Error, setTimeout, clearTimeout });
const { readUpdateReply, browserUpdateState, updateView, awaitUpdateRequest, UPDATE_RELEASES_URL } = module.exports;

const validState = (extra = {}) => ({ status: "idle", currentVersion: "1.7.8", latestVersion: null, platform: "win32", disabledReason: null, checkedAt: null, progressPercent: null, retryAfterMs: 0, code: null, warningCode: null, ...extra });
function fixture(controller = { getState: () => ({ status: "idle" }), check() {} }, extra = {}) {
  const frame = { url: "wealth-atlas://app/" };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  const handlers = new Map(), opened = [];
  registerUpdateIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getController: () => controller,
    getContents: () => contents, getAppVersion: () => "1.7.8", platform: "win32",
    openReleaseNotes: async (url) => { opened.push(url); }, ...extra });
  return { contents, event, handlers, opened, call: (name, ...args) => handlers.get(CHANNELS[name])(event, ...args) };
}
class FakeUpdater extends EventEmitter {
  calls = 0;
  setFeedURL() {}
  async checkForUpdates() { this.calls++; this.emit("update-not-available", { version: "1.7.8" }); return {}; }
}

test("update IPC accepts only the exact owned main frame and parsed local origin", async () => {
  let checks = 0;
  const f = fixture({ getState: () => ({ status: "idle" }), check: () => { checks++; } });
  for (const url of ["https://example.invalid/", "wealth-atlas://app.evil/", "wealth-atlas://app@evil/", "wealth-atlas://app:123/", "wealth-atlas://app/showcase", "file:///index.html", "about:blank"]) {
    f.contents.mainFrame.url = url;
    assert.equal((await f.call("check")).code, "UPDATE_ACCESS_DENIED");
  }
  f.contents.mainFrame.url = "wealth-atlas://app/";
  const otherFrame = { url: "wealth-atlas://app/" };
  assert.equal((await f.handlers.get(CHANNELS.check)({ sender: f.contents, senderFrame: otherFrame })).code, "UPDATE_ACCESS_DENIED");
  assert.equal((await f.handlers.get(CHANNELS.check)({ sender: {}, senderFrame: f.contents.mainFrame })).code, "UPDATE_ACCESS_DENIED");
  assert.equal((await f.handlers.get(CHANNELS.check)({ sender: f.contents })).code, "UPDATE_ACCESS_DENIED");
  assert.equal(checks, 0);
  assert.equal((await f.call("check")).ok, true);
  assert.equal(checks, 1);
});
test("development origin checks match exact host and port without prefix tricks", () => {
  const f = fixture();
  for (const [url, accepted] of [["http://127.0.0.1:3011/", true], ["http://127.0.0.1:30110/", false], ["http://127.0.0.1:3011.evil/", false], ["http://localhost:3011/", false]]) {
    f.contents.mainFrame.url = url;
    assert.equal(trustedUpdateSender(f.event, f.contents, "http://127.0.0.1:3011/"), accepted);
  }
});
test("renderer arguments cannot configure a feed, select a file or request installation", async () => {
  let calls = 0;
  const f = fixture({ getState: () => ({ status: "idle" }), check: () => { calls++; } });
  assert.equal(f.handlers.size, 3);
  for (const name of ["state", "check", "notes"]) for (const payload of [undefined, null, "https://example.invalid/", { path: "synthetic.exe" }, { quitAndInstall: true }]) {
    assert.equal((await f.call(name, payload)).code, "UPDATE_INVALID_REQUEST");
  }
  assert.equal(calls, 0); assert.equal(f.opened.length, 0);
});
test("state IPC strips all non-allowlisted fields and never returns provider secrets", async () => {
  const f = fixture({ getState: () => ({ status: "error", code: "SYNTHETIC_PRIVATE", message: "SYNTHETIC_PRIVATE", path: "SYNTHETIC_PRIVATE", headers: { Authorization: "SYNTHETIC_PRIVATE" } }) });
  const result = await f.call("state");
  assert.equal(result.ok, true);
  assert.equal(result.state.code, "UPDATE_FAILED");
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE"), false);
  assert.equal(Object.keys(result.state).length, 10);
});
test("IPC exceptions are fixed-code failures, including a closing window", async () => {
  const bad = () => { throw new Error("SYNTHETIC_PRIVATE"); };
  for (const extra of [{ getContents: bad }, { getController: bad }, { getAppVersion: bad }]) {
    const f = fixture(undefined, extra);
    const result = await f.call("state");
    assert.equal(result.ok, false); assert.equal(result.code, "UPDATE_BRIDGE_UNAVAILABLE");
    assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE"), false);
  }
});
test("check IPC acknowledges immediately while the real controller coalesces a request burst", async () => {
  const updater = new FakeUpdater();
  let finish;
  updater.checkForUpdates = () => { updater.calls++; return new Promise((resolve) => { finish = resolve; }); };
  const controller = setupAutoUpdates({ updater, isPackaged: true, platform: "win32" });
  const f = fixture(controller);
  const results = await Promise.all(Array.from({ length: 200 }, () => f.call("check")));
  assert.ok(results.every((reply) => reply.ok && reply.state.status === "checking"));
  assert.equal(updater.calls, 1);
  updater.emit("update-not-available", { version: "1.7.8" }); finish({});
  await controller.check();
});
test("release-note opening uses only the fixed public URL and is rate-limited", async () => {
  let clock = 0;
  const f = fixture(undefined, { now: () => clock });
  const results = await Promise.all(Array.from({ length: 50 }, () => f.call("notes")));
  assert.equal(results.filter((reply) => reply.ok).length, 1);
  assert.deepEqual(f.opened, [RELEASES_URL]);
  assert.equal(UPDATE_RELEASES_URL, RELEASES_URL);
  clock = Number.NaN;
  assert.equal((await f.call("notes")).ok, false);
  clock = 5000;
  assert.equal((await f.call("notes")).ok, true);
  assert.equal(f.opened.length, 2);
});
test("progress is bounded and monotonic, never a claim that checksum verification finished", async () => {
  const updater = new FakeUpdater();
  const controller = setupAutoUpdates({ updater, isPackaged: true, platform: "win32", now: () => 0 });
  await controller.check();
  updater.emit("update-available", { version: "1.7.9" });
  for (const [value, expected] of [[-2, 0], [43.27, 43.2], [3, 43.2], [Infinity, 43.2], [NaN, 43.2], [120, 100]]) {
    updater.emit("download-progress", { percent: value });
    assert.equal(controller.getState().progressPercent, expected);
    assert.equal(controller.getState().status, "downloading");
  }
  updater.emit("download-progress", { get percent() { throw new Error("SYNTHETIC_PRIVATE"); } });
  updater.emit("update-downloaded", { version: "1.7.9" });
  assert.equal(controller.getState().progressPercent, null);
  assert.equal(controller.getState().checkedAt, 0);
  assert.equal(controller.getState().latestVersion, "1.7.9");
});
test("progress events after failure cannot revive state or leak log payloads", async () => {
  const updater = new FakeUpdater();
  const controller = setupAutoUpdates({ updater, isPackaged: true, platform: "win32" });
  await controller.check();
  updater.emit("update-available", { version: "1.7.9" });
  updater.emit("error", { code: "ERR_CHECKSUM_MISMATCH" });
  updater.emit("download-progress", { percent: 100, path: "SYNTHETIC_PRIVATE" });
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().progressPercent, null);
});
test("state decoding rejects hostile values, unexpected private fields and unknown schemas", () => {
  assert.ok(readUpdateReply({ ok: true, state: validState() }));
  for (const patch of [{ progressPercent: Infinity }, { checkedAt: NaN }, { retryAfterMs: -1 }, { latestVersion: "<script>" }, { code: "SYNTHETIC_PRIVATE" }, { status: "invented" }, { snapshot: "SYNTHETIC_PRIVATE" }, { warningCode: "ENOTFOUND" }]) {
    assert.equal(readUpdateReply({ ok: true, state: validState(patch) }), null);
  }
  for (const value of [null, [], { ok: false, code: "SYNTHETIC_PRIVATE" }, { get ok() { throw new Error("synthetic"); } }]) assert.equal(readUpdateReply(value), null);
});
test("state serialization bounds numeric values and never forwards release notes or paths", () => {
  const result = serializeUpdateState({ status: "downloading", progressPercent: 1000, retryAfterMs: Infinity, checkedAt: -1, latestVersion: "1".repeat(1000), releaseNotes: "SYNTHETIC_PRIVATE" }, "1.7.8", "win32");
  assert.equal(result.progressPercent, 100);
  assert.equal(result.latestVersion, null); assert.equal(result.checkedAt, null); assert.equal(result.retryAfterMs, 0);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_PRIVATE"), false);
});
test("browser, isolated and integrity-failure copy cannot falsely claim an installed update", () => {
  assert.equal(updateView(browserUpdateState("1.7.8")).locked, true);
  assert.equal(updateView(validState({ status: "disabled", disabledReason: "isolated-test" })).locked, true);
  assert.match(updateView(validState({ status: "error", code: "ERR_CHECKSUM_MISMATCH" })).title, /暂停安装/);
  assert.match(updateView(validState({ status: "downloaded" })).detail, /正常关闭/);
});
test("cancelled update reads never invoke IPC and a timeout does not expose underlying errors", async () => {
  const aborted = new AbortController(); aborted.abort();
  let calls = 0;
  await assert.rejects(awaitUpdateRequest(async () => { calls++; }, aborted.signal), /UPDATE_REQUEST_UNAVAILABLE/);
  assert.equal(calls, 0);
  await assert.rejects(awaitUpdateRequest(() => new Promise(() => {}), new AbortController().signal, 5), /UPDATE_REQUEST_UNAVAILABLE/);
  await assert.rejects(awaitUpdateRequest(async () => { throw new Error("SYNTHETIC_PRIVATE"); }, new AbortController().signal), (error) => error.message === "UPDATE_REQUEST_UNAVAILABLE");
});
test("unmount-style abort settles a pending read without waiting for an SDK reply", async () => {
  const abort = new AbortController();
  const pending = awaitUpdateRequest(() => new Promise(() => {}), abort.signal);
  await Promise.resolve(); abort.abort();
  await assert.rejects(pending, /UPDATE_REQUEST_UNAVAILABLE/);
});
