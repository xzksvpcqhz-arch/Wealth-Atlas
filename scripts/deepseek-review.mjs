#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"];
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const MAX_OUTPUT_CHARS = 48_000;
const MAX_SOURCE_CHARS = 120_000;
const MAX_REVIEW_CHARS = 360_000;

const RELATED_SOURCE_CANDIDATES = [
  "components/WealthAtlasV2.tsx",
  "components/FxCenter.tsx",
  "components/AdvancedWorkbench.tsx",
  "lib/finance.ts",
  "lib/storage.ts",
  "lib/types.ts",
  "lib/migrations.ts",
  "lib/exporters.ts",
  "package.json",
  "scripts/deepseek-review.mjs",
];

function trimOutput(value = "", max = MAX_OUTPUT_CHARS) {
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function redact(value = "", secret = "") {
  return secret ? String(value).split(secret).join("[REDACTED]") : String(value);
}

function runCommand(command, args, options = {}) {
  const useShell = options.shell ?? false;
  const result = spawnSync(useShell ? [command, ...args].join(" ") : command, useShell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    shell: useShell,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: typeof result.status === "number" ? result.status : 1,
    error: result.error?.message ?? "",
  };
}

function parseEnvFile(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || !ENV_KEYS.includes(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadConfiguration(root) {
  let fileValues = {};
  try {
    fileValues = parseEnvFile(await readFile(join(root, ".env.local"), "utf8"));
  } catch {
    fileValues = {};
  }

  const values = {};
  for (const key of ENV_KEYS) {
    values[key] = process.env[key]?.trim() || fileValues[key]?.trim() || "";
  }
  return {
    apiKey: values.DEEPSEEK_API_KEY,
    baseUrl: values.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    model: values.DEEPSEEK_MODEL || DEFAULT_MODEL,
  };
}

function detectPackageManager(root) {
  if (runCommand("cmd", ["/c", "if exist package-lock.json (exit 0) else (exit 1)"], { cwd: root }).exitCode === 0) return "npm";
  if (runCommand("cmd", ["/c", "if exist pnpm-lock.yaml (exit 0) else (exit 1)"], { cwd: root }).exitCode === 0) return "pnpm";
  if (runCommand("cmd", ["/c", "if exist yarn.lock (exit 0) else (exit 1)"], { cwd: root }).exitCode === 0) return "yarn";
  return "npm";
}

function packageManagerCommand(manager) {
  if (process.platform === "win32" && manager === "npm") return "npm.cmd";
  return manager;
}

function isExcludedPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const baseName = segments.at(-1) ?? normalized;
  if (segments.some((segment) => ["data", "exports", "private-vault", "backups", "node_modules", ".next"].includes(segment))) return true;
  if (baseName === ".env.local" || baseName.startsWith(".env.")) return true;
  if (/\.(?:png|jpe?g|gif|webp|zip|xlsx|xls|csv|pdf)$/iu.test(baseName)) return true;
  return false;
}

function gitRoot() {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  if (result.exitCode !== 0) throw new Error("无法确定 Git 项目根目录。");
  return result.stdout.trim();
}

function changedSafeFiles(root) {
  const result = runCommand("git", ["diff", "--name-only", "HEAD", "--"], { cwd: root });
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).filter((item) => !isExcludedPath(item));
}

function collectDiff(root, files) {
  if (!files.length) return "(当前没有已跟踪文件的 Git diff。)";
  const result = runCommand("git", ["diff", "--no-ext-diff", "--unified=80", "HEAD", "--", ...files], { cwd: root });
  if (result.exitCode !== 0) return `(读取 Git diff 失败：${trimOutput(result.stderr || result.error, 2_000)})`;
  return trimOutput(result.stdout || "(当前 diff 为空。)", MAX_SOURCE_CHARS);
}

async function collectRelatedSources(root, changedFiles) {
  const candidates = [...new Set([...changedFiles, ...RELATED_SOURCE_CANDIDATES])].filter((filePath) => !isExcludedPath(filePath));
  const sections = [];
  let total = 0;

  for (const filePath of candidates) {
    const absolutePath = resolve(root, filePath);
    const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
    if (relativePath.startsWith("../") || isExcludedPath(relativePath)) continue;
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > MAX_SOURCE_CHARS) continue;
      const source = await readFile(absolutePath, "utf8");
      const remaining = MAX_REVIEW_CHARS - total;
      if (remaining <= 0) break;
      const content = source.slice(0, Math.min(MAX_SOURCE_CHARS, remaining));
      sections.push(`--- ${relativePath} ---\n${content}${content.length < source.length ? "\n...[truncated]" : ""}`);
      total += content.length;
    } catch {
      // A missing optional source file is not an audit failure.
    }
  }

  return sections.length ? sections.join("\n\n") : "(没有可读取的相关源码。)";
}

function runProjectTests(root, manager, apiKey) {
  const childEnv = { ...process.env };
  for (const key of ENV_KEYS) delete childEnv[key];
  const command = packageManagerCommand(manager);
  const result = runCommand(command, ["run", "test"], { cwd: root, env: childEnv, shell: process.platform === "win32" });
  return {
    command: `${manager} run test`,
    passed: result.exitCode === 0 && !result.error,
    exitCode: result.exitCode,
    stdout: redact(trimOutput(result.stdout), apiKey),
    stderr: redact(trimOutput(result.stderr || result.error), apiKey),
  };
}

function extractJson(content) {
  const text = typeof content === "string" ? content.trim() : JSON.stringify(content);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim() ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("DeepSeek 返回内容中没有 JSON 对象。");
  return JSON.parse(fenced.slice(start, end + 1));
}

function localIssue(id, severity, file, problem, suggestedFix) {
  return { id, severity, file, line: 0, problem, suggested_fix: suggestedFix };
}

function normalizeReview(review, tests) {
  const issues = Array.isArray(review?.issues) ? review.issues.map((issue, index) => ({
    id: typeof issue?.id === "string" ? issue.id : `DS-${String(index + 1).padStart(3, "0")}`,
    severity: ["P0", "P1", "P2"].includes(issue?.severity) ? issue.severity : "P2",
    file: typeof issue?.file === "string" ? issue.file : "unknown",
    line: Number.isInteger(issue?.line) ? issue.line : 0,
    problem: typeof issue?.problem === "string" ? issue.problem : "未提供问题说明。",
    suggested_fix: typeof issue?.suggested_fix === "string" ? issue.suggested_fix : "请重新检查相关代码。",
  })) : [];

  if (!tests.passed) {
    issues.push(localIssue("DS-LOCAL-TEST", "P1", "package.json", "项目现有 test 未通过，不能判定为 PASS。", `先修复 ${tests.command} 的失败，再重新运行审核。`));
  }

  const validStatus = review?.status === "PASS" || review?.status === "FAIL";
  if (!validStatus) {
    issues.push(localIssue("DS-LOCAL-JSON", "P1", "scripts/deepseek-review.mjs", "DeepSeek 返回的 status 不是 PASS 或 FAIL。", "让审核模型严格返回约定 JSON schema。"));
  }

  const hasBlockingIssue = issues.some((issue) => issue.severity === "P0" || issue.severity === "P1");
  const status = review?.status === "PASS" && validStatus && tests.passed && !hasBlockingIssue ? "PASS" : "FAIL";
  const modelSummary = typeof review?.summary === "string" ? review.summary : "DeepSeek 未提供有效审核总结。";
  const summary = status === "PASS" ? modelSummary : `${modelSummary}${tests.passed ? "" : " 项目 test 未通过，因此审核结果被本地规则强制标记为 FAIL。"}`;
  const testsToRepeat = Array.isArray(review?.tests_to_repeat) ? review.tests_to_repeat.filter((item) => typeof item === "string") : [];
  return { status, summary, issues, tests_to_repeat: testsToRepeat };
}

async function requestReview(config, prompt) {
  const endpoint = `${config.baseUrl.replace(/\/$/u, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是 Wealth Atlas 的严格代码审核器。只审核用户提供的 diff、源码、测试结果和错误日志。必须只返回一个 JSON 对象，不要 Markdown，不要解释 JSON 之外的内容。" },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）。`);
  const parsed = JSON.parse(responseText);
  return extractJson(parsed?.choices?.[0]?.message?.content);
}

async function main() {
  const root = gitRoot();
  const config = await loadConfiguration(root);
  const manager = detectPackageManager(root);
  const tests = runProjectTests(root, manager, config.apiKey);
  const changedFiles = changedSafeFiles(root);
  const diff = collectDiff(root, changedFiles);
  const sources = await collectRelatedSources(root, changedFiles);
  const errorLogs = tests.stderr || "(没有测试错误日志。)";
  const prompt = [
    "请审核当前 Wealth Atlas 项目。只根据以下材料判断，不要猜测未提供的文件。",
    "审核规则：只有项目 test 通过、且没有 P0/P1 问题时才返回 PASS；P2 可以保留在 issues 中。",
    '返回 schema：{"status":"PASS|FAIL","summary":"...","issues":[{"id":"DS-001","severity":"P0|P1|P2","file":"文件路径","line":0,"problem":"问题说明","suggested_fix":"建议修复方式"}],"tests_to_repeat":[]}',
    `包管理器：${manager}`,
    `Git diff：\n${diff}`,
    `相关源码：\n${sources}`,
    `测试结果：\n${JSON.stringify(tests, null, 2)}`,
    `错误日志：\n${errorLogs}`,
  ].join("\n\n");

  if (!config.apiKey) {
    console.log(JSON.stringify({
      status: "FAIL",
      summary: "未找到 DEEPSEEK_API_KEY，尚未发起审核请求。",
      issues: [localIssue("DS-LOCAL-ENV", "P1", ".env.local", "缺少 DEEPSEEK_API_KEY。", "在项目根目录 .env.local 设置 DEEPSEEK_API_KEY 后重新运行 npm run ai:review。")],
      tests_to_repeat: [tests.command],
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (prompt.includes(config.apiKey)) throw new Error("审核请求材料意外包含 API Key，已阻止发送。");

  try {
    const review = await requestReview(config, prompt);
    const result = normalizeReview(review, tests);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      status: "FAIL",
      summary: "DeepSeek 审核请求或 JSON 解析失败。",
      issues: [localIssue("DS-LOCAL-API", "P1", "scripts/deepseek-review.mjs", error instanceof Error ? error.message : "未知 API 错误。", "检查 .env.local 中的 Base URL、Model 和网络连接后重试。")],
      tests_to_repeat: [tests.command],
    }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.log(JSON.stringify({
    status: "FAIL",
    summary: "本地审核脚本启动失败。",
    issues: [localIssue("DS-LOCAL-RUN", "P1", "scripts/deepseek-review.mjs", error instanceof Error ? error.message : "未知本地错误。", "修复本地运行环境后重试。")],
    tests_to_repeat: [],
  }, null, 2));
  process.exitCode = 1;
});
