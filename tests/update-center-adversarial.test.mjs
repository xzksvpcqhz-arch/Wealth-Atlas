import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

// All transports, clocks, release metadata and DOM nodes below are synthetic.
// This suite never opens an Electron profile, reads a database or installs files.
const { setupAutoUpdates, PUBLIC_FEED } = createRequire(import.meta.url)("../desktop/updater.cjs");
class FixtureUpdater extends EventEmitter {
  calls = 0;
  quits = 0;
  setFeedURL(feed) { this.feed = feed; }
  quitAndInstall() { this.quits++; }
  async checkForUpdates() {
    this.calls++;
    this.emit("update-not-available", { version: "1.7.8" });
    return { updateInfo: { version: "1.7.8" } };
  }
}
const config = (updater, extras = {}) => ({ updater, isPackaged: true, platform: "win32", ...extras });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

test("burst of 200 checks shares one request, one controller and one listener set", async () => {
  const updater = new FixtureUpdater();
  const pending = deferred();
  updater.checkForUpdates = () => { updater.calls++; return pending.promise; };
  const controller = setupAutoUpdates(config(updater));
  const checks = Array.from({ length: 200 }, () => controller.check());
  assert.equal(setupAutoUpdates(config(updater)), controller);
  assert.ok(checks.every((item) => item === checks[0]));
  await Promise.resolve();
  assert.equal(updater.calls, 1);
  updater.emit("update-not-available", { version: "1.7.8" });
  pending.resolve({ updateInfo: { version: "1.7.8" } });
  await Promise.all(checks);
  for (const event of ["update-available", "update-not-available", "update-downloaded", "error"]) {
    assert.equal(updater.listenerCount(event), 1);
  }
});

test("pending download remains single-flight across repeated check attempts", async () => {
  const updater = new FixtureUpdater();
  const download = deferred();
  updater.checkForUpdates = async () => {
    updater.calls++;
    updater.emit("update-available", { version: "1.7.9" });
    return { downloadPromise: download.promise };
  };
  const controller = setupAutoUpdates(config(updater));
  const pending = controller.check();
  await Promise.resolve();
  for (let i = 0; i < 100; i++) assert.equal(controller.check(), pending);
  updater.emit("update-downloaded", { version: "1.7.9" });
  download.resolve([]);
  await pending;
  assert.equal(updater.calls, 1);
  assert.equal(controller.getState().status, "downloaded");
  assert.equal(updater.quits, 0);
});
test("offline retry is bounded, then recovers after its cooldown", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  updater.checkForUpdates = async () => { updater.calls++; throw Object.assign(new Error("synthetic offline"), { code: "ENOTFOUND" }); };
  const controller = setupAutoUpdates(config(updater, { now: () => clock }));
  await controller.check();
  clock = 59_999;
  await controller.check();
  assert.equal(updater.calls, 1);
  clock = 60_000;
  updater.checkForUpdates = async () => { updater.calls++; updater.emit("update-not-available", { version: "1.7.8" }); return {}; };
  await controller.check();
  assert.equal(updater.calls, 2);
  assert.equal(controller.getState().status, "up-to-date");
});

test("UC-001: a retry action either starts a permitted check or exposes an honest remaining cooldown", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  updater.checkForUpdates = async () => { updater.calls++; throw Object.assign(new Error("synthetic offline"), { code: "ENOTFOUND" }); };
  const controller = setupAutoUpdates(config(updater, { now: () => clock }));
  await controller.check();
  clock = 1_000;
  updater.checkForUpdates = async () => { updater.calls++; updater.emit("update-not-available", { version: "1.7.8" }); return {}; };
  const result = await controller.check({ manual: true });
  const hasCooldown = Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0;
  assert.ok(updater.calls === 2 || hasCooldown, "Retry silently returned cached error without a request or a visible cooldown contract");
});

test("UC-001: 200 early retries do not extend the deadline or duplicate a check at the exact boundary", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  updater.checkForUpdates = async () => { updater.calls++; throw Object.assign(new Error("synthetic offline"), { code: "ENOTFOUND" }); };
  const controller = setupAutoUpdates(config(updater, { now: () => clock }));
  await controller.check();
  clock = 59_999;
  const early = await Promise.all(Array.from({ length: 200 }, () => controller.check({ manual: true })));
  assert.equal(updater.calls, 1);
  assert.ok(early.every((state) => state.retryAfterMs === 1 && state.status === "error"));
  const pending = deferred();
  updater.checkForUpdates = () => { updater.calls++; return pending.promise; };
  clock = 60_000;
  assert.equal(controller.getState().retryAfterMs, 0);
  const checks = Array.from({ length: 200 }, () => controller.check({ manual: true }));
  assert.ok(checks.every((entry) => entry === checks[0]));
  await Promise.resolve();
  assert.equal(updater.calls, 2);
  updater.emit("update-not-available", { version: "1.7.8" });
  pending.resolve({ updateInfo: { version: "1.7.8" } });
  assert.ok((await Promise.all(checks)).every((state) => state.status === "up-to-date"));
  assert.equal(updater.quits, 0);
});

test("UC-001: invalid or backward clocks expose a finite bounded wait without allowing a request storm", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  updater.checkForUpdates = async () => { updater.calls++; throw Object.assign(new Error("synthetic offline"), { code: "ENOTFOUND" }); };
  const controller = setupAutoUpdates(config(updater, { now: () => {
    if (clock === "throw") throw new Error("synthetic clock failure");
    return clock;
  } }));
  await controller.check();
  for (clock of [-100_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "throw"]) {
    const state = controller.getState();
    assert.ok(Number.isFinite(state.retryAfterMs) && state.retryAfterMs > 0 && state.retryAfterMs <= 60_000);
    const retry = await controller.check({ manual: true });
    assert.ok(Number.isFinite(retry.retryAfterMs));
    assert.equal(updater.calls, 1);
  }
  clock = 60_000;
  assert.equal(controller.getState().retryAfterMs, 0);
});

test("UC-002: late not-available cannot erase an already verified pending download", async () => {
  const updater = new FixtureUpdater();
  const controller = setupAutoUpdates(config(updater));
  await controller.check();
  updater.emit("update-downloaded", { version: "1.7.9" });
  updater.emit("update-not-available", { version: "1.7.8" });
  assert.equal(controller.getState().status, "downloaded");
  assert.equal(controller.getState().version, "1.7.9");
});

test("UC-002: 200 late results preserve the exact pending version without false up-to-date logs or requests", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  const logs = [];
  const controller = setupAutoUpdates(config(updater, { now: () => clock, log: (...args) => logs.push(args) }));
  await controller.check();
  updater.emit("update-downloaded", { version: "1.7.9" });
  const ready = controller.getState();
  const logged = logs.length;
  for (let index = 0; index < 200; index++) {
    updater.emit("update-not-available", index % 2 ? { version: "1.7.8" } : undefined);
    assert.deepEqual(controller.getState(), ready);
  }
  assert.equal(logs.length, logged, "Ignored late events must not falsely log that the app is up-to-date");
  clock = 86_400_000;
  const responses = await Promise.all(Array.from({ length: 200 }, () => controller.check()));
  assert.ok(responses.every((state) => state.status === "downloaded" && state.version === "1.7.9" && state.retryAfterMs === 0));
  assert.equal(updater.calls, 1);
  assert.equal(updater.quits, 0);
});

test("UC-002: late no-update events during download and before promise settlement cannot regress its state", async () => {
  const updater = new FixtureUpdater();
  const download = deferred();
  updater.checkForUpdates = async () => {
    updater.calls++;
    updater.emit("update-available", { version: "1.7.9" });
    return { downloadPromise: download.promise };
  };
  const controller = setupAutoUpdates(config(updater));
  const pending = controller.check();
  await Promise.resolve();
  updater.emit("update-not-available", { version: "1.7.8" });
  assert.equal(controller.getState().status, "downloading");
  assert.equal(controller.getState().version, "1.7.9");
  assert.equal(controller.check(), pending);
  updater.emit("update-downloaded", { version: "1.7.9" });
  updater.emit("update-not-available", { version: "1.7.8" });
  download.resolve([]);
  const settled = await pending;
  assert.equal(settled.status, "downloaded");
  assert.equal(settled.version, "1.7.9");
  assert.equal(updater.calls, 1);
  assert.equal(updater.quits, 0);
});

test("UC-003: a late network error cannot make a pending installer disappear from the UI contract", async () => {
  const updater = new FixtureUpdater();
  const controller = setupAutoUpdates(config(updater));
  await controller.check();
  updater.emit("update-downloaded", { version: "1.7.9" });
  updater.emit("error", Object.assign(new Error("synthetic later network failure"), { code: "ENOTFOUND" }));
  const state = controller.getState();
  assert.ok(state.status === "downloaded" && state.version === "1.7.9"
    || state.pendingVersion === "1.7.9", "Pending installation metadata was erased");
});

test("UC-003: repeated safe network errors stay enum-only warnings and do not trigger checks or installation", async () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]) {
    const updater = new FixtureUpdater();
    const logs = [];
    const controller = setupAutoUpdates(config(updater, { log: (...args) => logs.push(args) }));
    await controller.check();
    updater.emit("update-downloaded", { version: "1.7.9" });
    const logged = logs.length;
    for (let index = 0; index < 200; index++) {
      updater.emit("error", Object.assign(new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"), { code }));
      assert.equal(controller.getState().status, "downloaded");
      assert.equal(controller.getState().version, "1.7.9");
      assert.equal(controller.getState().warningCode, code);
    }
    await controller.check();
    assert.equal(logs.length, logged + 1, "Repeated identical warnings should be deduplicated");
    assert.equal(JSON.stringify({ logs, state: controller.getState() }).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"), false);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.equal(updater.calls, 1);
    assert.equal(updater.quits, 0);
  }
});

test("UC-003: integrity and unknown errors cannot become harmless warnings or install on normal quit", async () => {
  for (const code of ["ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH", "SYNTHETIC_UNKNOWN_ERROR"]) {
    const updater = new FixtureUpdater();
    let clock = 0;
    const controller = setupAutoUpdates(config(updater, { now: () => clock }));
    await controller.check();
    updater.emit("update-downloaded", { version: "1.7.9" });
    updater.emit("error", Object.assign(new Error("synthetic non-network failure"), { code }));
    assert.equal(controller.getState().status, "error");
    assert.equal(controller.getState().warningCode, undefined);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.quits, 0);
    clock = 60_000;
    updater.checkForUpdates = async () => {
      updater.calls++;
      updater.emit("update-available", { version: "1.7.9" });
      updater.emit("update-downloaded", { version: "1.7.9" });
      return { downloadPromise: Promise.resolve([]) };
    };
    const verifiedAgain = await controller.check();
    assert.equal(verifiedAgain.status, "downloaded");
    assert.equal(verifiedAgain.warningCode, undefined);
    assert.equal(updater.autoInstallOnAppQuit, true);
    assert.equal(updater.calls, 2);
  }
});

test("UC-003: late success events cannot erase an integrity failure or re-arm the rejected installer", async () => {
  const updater = new FixtureUpdater();
  const logs = [];
  const controller = setupAutoUpdates(config(updater, { log: (...args) => logs.push(args) }));
  await controller.check();
  updater.emit("update-downloaded", { version: "1.7.9" });
  updater.emit("error", Object.assign(new Error("synthetic integrity failure"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }));
  const failed = controller.getState();
  const logged = logs.length;
  for (let index = 0; index < 200; index++) {
    updater.emit("update-not-available", { version: "1.7.8" });
    updater.emit("update-available", { version: "1.7.9" });
    updater.emit("update-downloaded", { version: "1.7.9" });
    assert.equal(controller.getState().status, "error");
    assert.equal(controller.getState().code, failed.code);
    assert.equal(updater.autoInstallOnAppQuit, false);
  }
  assert.equal(logs.length, logged);
  assert.equal(updater.calls, 1);
  assert.equal(updater.quits, 0);
});

test("UC-004: configuration failure must fail closed rather than call an unconfigured updater", async () => {
  const updater = new FixtureUpdater();
  updater.setFeedURL = () => { throw new Error("synthetic provider configuration failure"); };
  const controller = setupAutoUpdates(config(updater));
  assert.equal(controller.getState().status, "error");
  await controller.check();
  assert.equal(updater.calls, 0, "checkForUpdates ran even though the trusted feed was never configured");
});

test("UC-004: failures at every setup boundary cannot leave usable partial handlers or leak provider details", async () => {
  const phases = ["feed", "logger", "requestHeaders", "autoDownload", "autoInstallOnAppQuit", "allowPrerelease", "allowDowngrade", "disableWebInstaller",
    ...["error", "checking-for-update", "update-available", "update-not-available", "update-downloaded"].flatMap((event) => ["before:" + event, "after:" + event])];
  for (const phase of phases) {
    const updater = new FixtureUpdater();
    const logs = [];
    const failure = () => { throw new Error("SYNTHETIC_PRIVATE_CONFIGURATION_DETAIL"); };
    if (phase === "feed") updater.setFeedURL = failure;
    else if (!phase.includes(":")) Object.defineProperty(updater, phase, { configurable: true, set: failure });
    else {
      const [when, failedEvent] = phase.split(":");
      const attach = updater.on.bind(updater);
      updater.on = (event, listener) => {
        if (event === failedEvent && when === "before") failure();
        const result = attach(event, listener);
        if (event === failedEvent && when === "after") failure();
        return result;
      };
    }
    const controller = setupAutoUpdates(config(updater, { log: (...args) => logs.push(args) }));
    for (let index = 0; index < 50; index++) {
      assert.equal(setupAutoUpdates(config(updater)), controller);
      assert.equal((await controller.check()).code, "UPDATE_CONFIGURATION_FAILED", phase);
      for (const event of ["checking-for-update", "update-available", "update-not-available", "update-downloaded"]) {
        updater.emit(event, { version: "1.7.9" });
      }
    }
    if (updater.listenerCount("error")) updater.emit("error", Object.assign(new Error("SYNTHETIC_PRIVATE_CONFIGURATION_DETAIL"), { code: "ENOTFOUND" }));
    assert.equal(controller.getState().status, "error", phase);
    assert.equal(controller.getState().code, "UPDATE_CONFIGURATION_FAILED", phase);
    assert.equal(controller.getState().version, undefined);
    assert.equal(updater.calls, 0, phase);
    assert.equal(updater.quits, 0);
    assert.equal(JSON.stringify({ state: controller.getState(), logs }).includes("SYNTHETIC_PRIVATE_CONFIGURATION_DETAIL"), false);
    for (const event of ["error", "checking-for-update", "update-available", "update-not-available", "update-downloaded"]) assert.ok(updater.listenerCount(event) <= 1, phase);
  }
});

test("UC-004: an SDK error emitted synchronously during setup blocks checks even if the setter returns", async () => {
  const updater = new FixtureUpdater();
  updater.setFeedURL = () => updater.emit("error", Object.assign(new Error("synthetic setup emission"), { code: "ENOTFOUND" }));
  const controller = setupAutoUpdates(config(updater));
  const state = await controller.check();
  assert.equal(state.status, "error");
  assert.equal(state.code, "UPDATE_CONFIGURATION_FAILED");
  assert.equal(updater.calls, 0);
  assert.equal(updater.autoInstallOnAppQuit, false);
});

test("UC-005: a disabled SDK returning null cannot leave the UI checking forever", async () => {
  const updater = new FixtureUpdater();
  updater.checkForUpdates = async () => { updater.calls++; return null; };
  const controller = setupAutoUpdates(config(updater));
  const result = await controller.check();
  assert.notEqual(result.status, "checking", "The request settled with no SDK event, but checking never settled");
  assert.ok(["disabled", "error", "unavailable"].includes(result.status));
});

test("UC-005: empty and incomplete results settle safely, coalesce retries and never leak result fields", async () => {
  const cases = [
    { value: null }, { value: undefined }, { value: {} },
    { value: { updateInfo: { version: "999.0.0", notes: "SYNTHETIC_PRIVATE_SDK_FIELD" } } },
    { value: { downloadPromise: Promise.resolve([]) } },
    { value: null, available: true },
    { value: { downloadPromise: Promise.resolve([]) }, available: true },
  ];
  for (const entry of cases) {
    const updater = new FixtureUpdater();
    let clock = 0;
    const logs = [];
    updater.checkForUpdates = async () => {
      updater.calls++;
      if (entry.available) updater.emit("update-available", { version: "1.7.9" });
      return entry.value;
    };
    const controller = setupAutoUpdates(config(updater, { now: () => clock, log: (...args) => logs.push(args) }));
    const burst = Array.from({ length: 200 }, () => controller.check());
    assert.ok(burst.every((request) => request === burst[0]));
    const results = await Promise.all(burst);
    assert.ok(results.every((state) => state.status === "error" && state.code === "UPDATE_RESULT_UNAVAILABLE" && state.retryAfterMs === 60_000));
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.calls, 1);
    assert.equal(JSON.stringify({ results, logs }).includes("SYNTHETIC_PRIVATE_SDK_FIELD"), false);
    await controller.check();
    assert.equal(updater.calls, 1);
    clock = 60_000;
    updater.checkForUpdates = async () => { updater.calls++; updater.emit("update-not-available", { version: "1.7.8" }); return {}; };
    assert.equal((await controller.check()).status, "up-to-date");
    assert.equal(updater.calls, 2);
    assert.equal(updater.quits, 0);
  }
});

test("UC-005: null results cannot overwrite genuine no-update, verified-download or specific-error events", async () => {
  for (const entry of [
    { event: "update-not-available", info: { version: "1.7.8" }, expected: "up-to-date" },
    { event: "update-downloaded", info: { version: "1.7.9" }, expected: "downloaded" },
    { event: "error", info: Object.assign(new Error("synthetic request error"), { code: "ETIMEDOUT" }), expected: "error", code: "ETIMEDOUT" },
  ]) {
    const updater = new FixtureUpdater();
    updater.checkForUpdates = async () => { updater.calls++; updater.emit(entry.event, entry.info); return null; };
    const controller = setupAutoUpdates(config(updater));
    const state = await controller.check();
    assert.equal(state.status, entry.expected);
    assert.equal(state.code, entry.code);
    if (entry.expected === "downloaded") assert.equal(state.version, "1.7.9");
    assert.equal(updater.quits, 0);
  }
});

test("failed checksum or signature never becomes a downloaded success", async () => {
  for (const code of ["ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_SIGNATURE"]) {
    const updater = new FixtureUpdater();
    updater.checkForUpdates = async () => {
      updater.calls++;
      updater.emit("update-available", { version: "1.7.9" });
      return { downloadPromise: Promise.reject(Object.assign(new Error("synthetic rejected payload"), { code })) };
    };
    const controller = setupAutoUpdates(config(updater));
    const state = await controller.check();
    assert.equal(state.status, "error");
    assert.equal(state.code, code);
    assert.equal(updater.quits, 0);
  }
});

test("a late integrity failure is not downgraded to an install-ready network warning", async () => {
  for (const code of ["ERR_UPDATER_SHA512_CHECKSUM_MISMATCH", "ERR_CHECKSUM_MISMATCH", "ERR_UPDATER_INVALID_SIGNATURE"]) {
    const updater = new FixtureUpdater();
    const controller = setupAutoUpdates(config(updater));
    await controller.check();
    updater.emit("update-downloaded", { version: "1.7.9" });
    updater.emit("error", Object.assign(new Error("synthetic integrity failure"), { code }));
    const state = controller.getState();
    assert.notEqual(state.status, "downloaded");
    assert.equal(state.code, code);
    assert.equal(updater.quits, 0);
  }
});

test("errors, URLs, headers and synthetic sensitive text do not escape to state or application logs", async () => {
  const updater = new FixtureUpdater();
  const logs = [];
  const sentinel = "SYNTHETIC-PRIVATE-CONTENT-DO-NOT-LOG";
  updater.checkForUpdates = async () => { throw Object.assign(new Error(sentinel), { code: sentinel, url: "https://example.invalid/" + sentinel, headers: { Authorization: sentinel } }); };
  const controller = setupAutoUpdates(config(updater, { log: (...args) => logs.push(args) }));
  await controller.check();
  const output = JSON.stringify({ state: controller.getState(), logs });
  assert.equal(output.includes(sentinel), false);
  assert.equal(output.includes("example.invalid"), false);
  assert.equal(controller.getState().code, "UPDATE_FAILED");
});

test("untrusted version text never enters the exposed state or logs", async () => {
  const updater = new FixtureUpdater();
  const logs = [];
  const controller = setupAutoUpdates(config(updater, { log: (...args) => logs.push(args) }));
  await controller.check();
  updater.emit("update-available", { version: '<img src=x onerror="SYNTHETIC_PAYLOAD">' });
  assert.equal(controller.getState().version, "unknown");
  assert.equal(JSON.stringify({ state: controller.getState(), logs }).includes("SYNTHETIC_PAYLOAD"), false);
});

test("diagnostic logger failure never blocks checks or startup", async () => {
  const updater = new FixtureUpdater();
  const controller = setupAutoUpdates(config(updater, { log: () => { throw new Error("synthetic log write failure"); } }));
  assert.equal((await controller.check()).status, "up-to-date");
});

test("callers cannot mutate the internal update state", async () => {
  const updater = new FixtureUpdater();
  const controller = setupAutoUpdates(config(updater));
  await controller.check();
  const exposed = controller.getState();
  exposed.status = "downloaded";
  exposed.version = "999.0.0";
  assert.equal(controller.getState().status, "up-to-date");
  assert.equal(controller.getState().version, undefined);
});

test("development, isolated profiles, non-Windows and missing updater make no update requests", async () => {
  for (const extra of [{ isPackaged: false }, { isolated: true }, { platform: "darwin" }, { platform: "linux" }]) {
    const updater = new FixtureUpdater();
    const controller = setupAutoUpdates(config(updater, extra));
    for (let i = 0; i < 10; i++) assert.equal((await controller.check()).status, "disabled");
    assert.equal(updater.calls, 0);
  }
  assert.equal((await setupAutoUpdates(config(null)).check()).status, "disabled");
});

test("the public feed cannot inherit auth headers, prerelease or downgrade settings", async () => {
  const updater = new FixtureUpdater();
  updater.requestHeaders = { Authorization: "SYNTHETIC-AUTH" };
  updater.allowPrerelease = true;
  updater.allowDowngrade = true;
  const controller = setupAutoUpdates(config(updater));
  await controller.check();
  assert.deepEqual(updater.feed, PUBLIC_FEED);
  assert.equal(updater.requestHeaders, null);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test("repeated completed events never force quit or trigger another check", async () => {
  const updater = new FixtureUpdater();
  let clock = 0;
  const controller = setupAutoUpdates(config(updater, { now: () => clock }));
  await controller.check();
  for (let i = 0; i < 100; i++) updater.emit("update-downloaded", { version: "1.7.9" });
  clock = 86_400_000;
  await controller.check();
  assert.equal(updater.calls, 1);
  assert.equal(updater.quits, 0);
});
