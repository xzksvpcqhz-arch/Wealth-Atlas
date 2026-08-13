import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const requestPath = path.join(projectRoot, "review", "request.json");
const excludedPathNames = new Set([
  ".env.local",
  "data",
  "exports",
  "private-vault",
  "backups",
  "node_modules",
  ".next",
  "review",
  "outputs",
]);
const excludedExtensions = new Set([
  ".csv",
  ".gif",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".json",
  ".js",
  ".mjs",
  ".md",
  ".scss",
  ".ts",
  ".tsx",
]);
const excludedPaths = [
  ".env.local",
  "data/",
  "exports/",
  "private-vault/",
  "backups/",
  "review/",
  "outputs/",
];
const maxDiffCharacters = 250_000;
const maxUntrackedFileCharacters = 120_000;
const maxUntrackedTotalCharacters = 250_000;

function normalizeRepoPath(repoPath) {
  return repoPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isExcluded(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  const extension = path.posix.extname(fileName).toLowerCase();

  return (
    segments.some((segment) => excludedPathNames.has(segment)) ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    excludedExtensions.has(extension)
  );
}

function isReviewableUntrackedCode(repoPath) {
  return sourceExtensions.has(path.posix.extname(repoPath).toLowerCase());
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function redactSecrets(value) {
  return value
    .replace(/(DEEPSEEK_API_KEY\s*[=:]\s*)([^\s\r\n,}\]]+)/gi, "$1[REDACTED]")
    .replace(/(\"?DEEPSEEK_API_KEY\"?\s*:\s*\"?)([^\"\r\n,}]+)/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s\r\n]+)/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, "$1[REDACTED]");
}

function truncate(value, limit) {
  if (value.length <= limit) {
    return { value, truncated: false };
  }

  return {
    value: `${value.slice(0, limit)}\n\n[TRUNCATED BY CODEX REVIEW BRIDGE]`,
    truncated: true,
  };
}

async function readSafeFile(repoPath) {
  const absolutePath = path.resolve(projectRoot, repoPath);
  const fileContents = await readFile(absolutePath, "utf8");
  const limited = truncate(fileContents, maxUntrackedFileCharacters);

  return {
    path: normalizeRepoPath(repoPath),
    content: redactSecrets(limited.value),
    truncated: limited.truncated,
  };
}

async function main() {
  const changedFiles = runGit(["diff", "--name-only", "HEAD", "--"])
    .split(/\r?\n/)
    .map(normalizeRepoPath)
    .filter(Boolean)
    .filter((repoPath) => !isExcluded(repoPath));
  const untrackedFiles = runGit(["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map(normalizeRepoPath)
    .filter(Boolean)
    .filter((repoPath) => !isExcluded(repoPath))
    .filter(isReviewableUntrackedCode);

  let gitDiff = "";
  if (changedFiles.length > 0) {
    gitDiff = runGit([
      "diff",
      "--no-ext-diff",
      "--unified=80",
      "HEAD",
      "--",
      ...changedFiles,
    ]);
  }
  const limitedDiff = truncate(redactSecrets(gitDiff), maxDiffCharacters);

  const untrackedCode = [];
  let untrackedCharacters = 0;
  for (const repoPath of untrackedFiles) {
    if (untrackedCharacters >= maxUntrackedTotalCharacters) {
      break;
    }

    const file = await readSafeFile(repoPath);
    const remaining = maxUntrackedTotalCharacters - untrackedCharacters;
    if (file.content.length > remaining) {
      file.content = `${file.content.slice(0, remaining)}\n\n[TRUNCATED BY CODEX REVIEW BRIDGE]`;
      file.truncated = true;
    }
    untrackedCharacters += file.content.length;
    untrackedCode.push(file);
  }

  const request = {
    version: "1",
    status: "READY_FOR_HERMES",
    source: "codex",
    project: "wealth-atlas",
    created_at: new Date().toISOString(),
    package_manager: "npm",
    changed_files: changedFiles,
    git_diff: limitedDiff.value || "(当前没有已跟踪文件的 Git diff。)",
    git_diff_truncated: limitedDiff.truncated,
    untracked_code: untrackedCode,
    tests_to_repeat: ["npm run test", "npm run build"],
    excluded_paths: excludedPaths,
  };

  await mkdir(path.dirname(requestPath), { recursive: true });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

  console.log(`Prepared Hermes review request: ${path.relative(projectRoot, requestPath)}`);
  console.log(`Tracked diff files: ${changedFiles.length}`);
  console.log(`Untracked reviewable code files: ${untrackedCode.length}`);
  console.log("Sensitive paths and credentials were excluded or redacted.");
}

main().catch((error) => {
  console.error(`Could not prepare Hermes review request: ${error.message}`);
  process.exitCode = 1;
});
