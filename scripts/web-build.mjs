import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Web 静态导出构建（用于 Cloudflare Pages / 手机 PWA）。
// 与桌面构建的区别：不设 NEXT_PUBLIC_WEALTH_ATLAS_DESKTOP，且用绝对资源路径。
const projectRoot = process.cwd();
const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextCli, "build"], {
  cwd: projectRoot,
  env: {
    ...process.env,
    WEALTH_ATLAS_WEB_EXPORT: "1",
    // NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 由 Cloudflare 构建环境注入。
  },
  stdio: "inherit",
});

child.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  if (!existsSync(path.join(projectRoot, "out", "index.html"))) {
    console.error("Web export did not produce out/index.html.");
    process.exit(1);
  }
  console.log("Web static export ready: out/index.html");
});
