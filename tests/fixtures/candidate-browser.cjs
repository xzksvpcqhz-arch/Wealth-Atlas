// Read-only QA of the Mac web bundle in an isolated Chromium profile on Windows.
// This is NOT a claim that macOS or Safari was tested.
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
const [profile, address] = process.argv.slice(2);
if (!profile || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(address ?? "")) throw new Error("Invalid isolated candidate QA parameters");
app.setPath("userData", path.resolve(profile));
app.setPath("sessionData", path.resolve(profile));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(address) && !/^(data:|blob:)/.test(details.url) });
  });
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL(address);
});
app.on("window-all-closed", () => app.quit());
