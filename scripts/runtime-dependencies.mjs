import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const skip = /^(?:node_modules|tests?|__tests__|examples?|benchmarks?|\.git|\.github|\.env.*)$|\.(?:pem|pfx|p12|key)$/i;
async function copyCode(from, to) {
  const stat = await lstat(from);
  if (stat.isSymbolicLink()) throw new Error("Runtime staging refuses source links.");
  if (stat.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) if (!skip.test(name)) await copyCode(path.join(from, name), path.join(to, name));
  } else if (stat.isFile() && stat.nlink === 1) await copyFile(from, to, 1);
  else throw new Error("Runtime staging refuses nonregular code files.");
}

// Build dependencies may stay linked; the distributable runtime must be physical.
export async function stageRuntimeApplication(source, dependencyRoot, destination, { localCandidate = true } = {}) {
  await mkdir(destination); // Exclusive: never replace an older staging directory.
  for (const name of ["out", "desktop", "build"]) await copyCode(path.join(source, name), path.join(destination, name));
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  if (!localCandidate && pkg.wealthAtlasLocalReleaseCandidate === true) throw new Error("Local candidate source cannot be promoted to a formal runtime.");
  const { devDependencies, scripts, build, ...runtimePackage } = pkg;
  await writeFile(path.join(destination, "package.json"), JSON.stringify({ ...runtimePackage, ...(localCandidate ? { wealthAtlasLocalReleaseCandidate: true } : {}) }, null, 2) + "\n", { flag: "wx" });
  const installedRoot = await realpath(path.join(dependencyRoot, "node_modules")) + path.sep;
  async function stage(name, from, to, ancestry = new Set()) {
    if (!packageName.test(name)) throw new Error("Unsafe runtime dependency name.");
    const require = createRequire(path.join(from, "package.json"));
    let directory = path.dirname(require.resolve(name));
    let metadata;
    for (;;) {
      if (!directory.startsWith(installedRoot)) throw new Error("Runtime dependency escaped the installed code tree.");
      try { metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); } catch { metadata = null; }
      if (metadata?.name === name) break;
      directory = path.dirname(directory);
    }
    if (ancestry.has(directory)) return; // The same version is available from an ancestor.
    await copyCode(directory, to);
    const next = new Set(ancestry).add(directory);
    for (const child of Object.keys(metadata.dependencies ?? {})) await stage(child, directory, path.join(to, "node_modules", child), next);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) await stage(name, dependencyRoot, path.join(destination, "node_modules", name));
}

export function assertPackagedRuntimeDependencies(files, readPackage) {
  const all = new Set(files.map((file) => file.replaceAll("\\", "/").replace(/^\//, "")));
  const seen = new Set();
  function inspect(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const pkg = readPackage(file), directory = path.posix.dirname(file);
    if (file !== "package.json") {
      const main = path.posix.normalize(path.posix.join(directory, pkg.main || "index.js"));
      if (!main.startsWith(directory + "/") || ![main, main + ".js", main + "/index.js"].some((name) => all.has(name))) throw new Error("Packaged runtime entry is missing.");
    }
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!packageName.test(name)) throw new Error("Unsafe packaged dependency name.");
      let base = directory === "." ? "" : directory, found;
      for (;;) {
        const candidate = path.posix.join(base, "node_modules", name, "package.json");
        if (all.has(candidate)) { found = candidate; break; }
        if (!base) break;
        const parent = path.posix.dirname(base); base = parent === "." ? "" : parent;
      }
      if (!found) throw new Error("A required runtime dependency is missing from the package.");
      inspect(found);
    }
  }
  inspect("package.json");
  return seen.size - 1;
}
