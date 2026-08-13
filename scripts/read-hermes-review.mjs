import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const resultPath = path.resolve(process.cwd(), process.argv[2] ?? "review/result.json");

function assertResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("审核结果必须是 JSON 对象。");
  }
  if (result.status !== "PASS" && result.status !== "FAIL") {
    throw new Error('审核结果 status 必须是 "PASS" 或 "FAIL"。');
  }
  if (typeof result.summary !== "string") {
    throw new Error("审核结果 summary 必须是字符串。");
  }
  if (!Array.isArray(result.issues)) {
    throw new Error("审核结果 issues 必须是数组。");
  }
  if (!Array.isArray(result.tests_to_repeat)) {
    throw new Error("审核结果 tests_to_repeat 必须是数组。");
  }
  if (!Array.isArray(result.verified_requirements)) {
    throw new Error("审核结果 verified_requirements 必须是数组。");
  }
}

function printIssues(issues) {
  if (issues.length === 0) {
    console.log("Issues: none");
    return;
  }

  console.log("Issues:");
  for (const issue of issues) {
    const severity = issue?.severity ?? "UNKNOWN";
    const id = issue?.id ?? "NO-ID";
    const file = issue?.file ?? "unknown file";
    const line = Number.isFinite(issue?.line) ? `:${issue.line}` : "";
    console.log(`- [${severity}] ${id} ${file}${line}`);
    console.log(`  Problem: ${issue?.problem ?? "未提供问题说明"}`);
    if (issue?.suggested_fix) {
      console.log(`  Suggested fix: ${issue.suggested_fix}`);
    }
  }
}

async function main() {
  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取或解析 ${resultPath}: ${error.message}`);
  }

  assertResult(result);
  console.log(`Hermes review status: ${result.status}`);
  console.log(`Summary: ${result.summary}`);
  printIssues(result.issues);

  console.log("Tests to repeat:");
  if (result.tests_to_repeat.length === 0) {
    console.log("- none");
  } else {
    result.tests_to_repeat.forEach((test) => console.log(`- ${test}`));
  }

  console.log("Verified requirements:");
  if (result.verified_requirements.length === 0) {
    console.log("- none");
  } else {
    result.verified_requirements.forEach((requirement) => console.log(`- ${requirement}`));
  }

  process.exitCode = result.status === "PASS" ? 0 : 1;
}

main().catch((error) => {
  console.error(`Could not read Hermes review: ${error.message}`);
  process.exitCode = 1;
});
