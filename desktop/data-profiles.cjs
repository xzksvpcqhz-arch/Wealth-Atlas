const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");

/** Per-webContents capability + per-request immutable filesystem root. Not cloud authentication. */
function createDataProfileRouter(getLegacyRoot) {
  const contexts = new Map();
  const requests = new AsyncLocalStorage();
  function register(senderId, key) {
    if (key !== "local" && key !== "guest" && !/^cloud:[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error("Invalid desktop data profile.");
    const context = { key, token: randomUUID(), root: key === "local" ? getLegacyRoot() : path.join(getLegacyRoot(), "profiles", createHash("sha256").update(key).digest("hex")) };
    contexts.set(senderId, context);
    return context.token;
  }
  function run(senderId, envelope, handler) {
    const expected = contexts.get(senderId);
    const scope = envelope?.__profile;
    if (expected) {
      // Legacy local-only smoke tools may call the bridge without a scope.
      if (!(expected.key === "local" && !scope) && (scope?.key !== expected.key || scope?.token !== expected.token)) throw new Error("Desktop data profile changed; operation cancelled.");
    } else if (scope && scope.key !== "local") throw new Error("Desktop data profile is not ready.");
    const context = expected ?? { key: "local", root: getLegacyRoot() };
    const wrapped = envelope && Object.hasOwn(envelope, "__profile") && Object.hasOwn(envelope, "payload");
    return requests.run(context, () => handler(wrapped ? envelope.payload : envelope));
  }
  return { register, run,
    root: () => requests.getStore()?.root ?? getLegacyRoot(),
    isScoped: () => (requests.getStore()?.key ?? "local") !== "local",
    forget: (senderId) => contexts.delete(senderId),
  };
}
module.exports = { createDataProfileRouter };
