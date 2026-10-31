import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANDIDATE_PORT = 43175;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8" };
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); };

/** Read-only loopback static server. Never proxy Auth or accept financial data. */
export async function createCandidateServer({ siteRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "site"), port = CANDIDATE_PORT } = {}) {
  const root = await realpath(siteRoot);
  const server = http.createServer(async (req, res) => {
    const reply = (status, text) => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end(text); };
    const actualPort = server.address()?.port;
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) return reply(403, "Loopback host required");
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) return reply(403, "Cross-origin request refused");
    if (!["GET", "HEAD"].includes(req.method)) return reply(405, "Read-only server");
    try {
      const target = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${actualPort}`).pathname);
      if (target.includes("\0") || target.includes("\\")) return reply(400, "Invalid path");
      let file = path.resolve(root, "." + target);
      if (!inside(root, file)) return reply(403, "Outside site");
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      file = await realpath(file);
      if (!inside(root, file)) return reply(403, "Outside site");
      const bytes = await readFile(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Content-Length": bytes.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch { reply(404, "Not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await createCandidateServer();
    console.log(`Wealth Atlas SYNC TEST ONLY: http://127.0.0.1:${CANDIDATE_PORT}/`);
    console.log("Keep this window open. Sign in only with your empty test account. Ctrl+C stops the server, not your data.");
  } catch (error) {
    console.error(error.code === "EADDRINUSE" ? "Test port is already in use. Stop the previous test server; no data was changed."
      : "Could not start the local test site. Extract the complete package first; no data was changed.");
    process.exitCode = 1;
  }
}
