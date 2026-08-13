import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

function findPort(startAt = 3030) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const server = net.createServer();
      server.once("error", () => tryPort(port + 1));
      server.once("listening", () => server.close(() => resolve(port)));
      server.listen(port, "127.0.0.1");
    };
    tryPort(startAt);
    setTimeout(() => reject(new Error("无法找到桌面开发端口。")), 5000).unref();
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Next.js 开发服务器启动超时。");
}

const projectRoot = process.cwd();
const port = await findPort();
const url = `http://127.0.0.1:${port}`;
const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const electronBinary = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const environment = { ...process.env, NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP: "1" };
const next = spawn(process.execPath, [nextCli, "dev", "-H", "127.0.0.1", "-p", String(port)], { cwd: projectRoot, env: environment, stdio: "inherit" });

try {
  await waitForServer(url);
  const electron = spawn(electronBinary, [".", `--dev-url=${url}`], { cwd: projectRoot, env: environment, stdio: "inherit" });
  electron.on("exit", (code) => {
    next.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  next.kill();
  throw error;
}
