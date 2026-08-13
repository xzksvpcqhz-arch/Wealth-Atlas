import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextCli, "build"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    WEALTH_ATLAS_DESKTOP_BUILD: "1",
    NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP: "1",
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (!existsSync(path.join(projectRoot, "out", "index.html"))) {
    console.error("Desktop build did not produce out/index.html.");
    process.exit(1);
  }
  console.log("Desktop static build ready: out/index.html");
});
