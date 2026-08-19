import { getDesktopBridge } from "./desktop";
import { CURRENT_SCHEMA_VERSION } from "./migrations";

export type DiagnosticLevel = "info" | "error";
export type StartupStage = "electron-app-ready" | "local-protocol" | "logs-directory" | "browser-window" | "static-page" | "react-initialization" | "indexeddb-initialization" | "data-read" | "migration" | "home-ready";
export type StartupStageStatus = "running" | "success" | "failed";
export type SafeDiagnostic = {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  source: string;
  name: string;
  message: string;
  stack: string;
  appVersion: string;
  electronVersion: string;
  platform: string;
  mode: string;
  stage: StartupStage;
  schemaVersion: number;
};

const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]*(?:PRIVATE|OPENSSH) KEY-----/gi;
const URL_QUERY_PATTERN = /([?&](?:token|key|password|secret)=)[^&\s]+/gi;
const PRIVATE_FIELD_PATTERN = /("(?:account|balance|transaction|budget|asset|fxRate|obsidian|password|secret|apiKey)[^"]*"\s*:\s*)"[^"]*"/gi;
const MAX_MESSAGE_LENGTH = 700;
const MAX_STACK_LINES = 8;
let currentStartupStage: StartupStage = "react-initialization";

export function getCurrentStartupStage() {
  return currentStartupStage;
}

export async function reportStartupStage(stage: StartupStage, status: StartupStageStatus, errorId?: string) {
  currentStartupStage = stage;
  try { await getDesktopBridge()?.reportStartupStage({ stage, status, errorId }); }
  catch { /* Startup diagnostics must never become another application failure. */ }
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "")
    .replace(PRIVATE_KEY_PATTERN, "[redacted-key]")
    .replace(URL_QUERY_PATTERN, "$1[redacted]")
    .replace(PRIVATE_FIELD_PATTERN, '$1"[redacted-private-value]"')
    .replace(/\b(?:MYR|SGD|USD|RM)\s*[-+]?\d[\d,.]*/gi, "[redacted-financial-value]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, "[redacted-path]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .slice(0, maxLength);
}

function stackSummary(value: unknown) {
  return String(value ?? "")
    .split(/\r?\n/)
    .slice(0, MAX_STACK_LINES)
    .map((line) => cleanText(line, 500))
    .join("\n");
}

function errorParts(reason: unknown) {
  if (reason instanceof Error) return { name: reason.name || "Error", message: reason.message, stack: reason.stack };
  if (typeof reason === "string") return { name: "Error", message: reason, stack: "" };
  return { name: "Error", message: "Unexpected application error", stack: "" };
}

export function createSafeDiagnostic(source: string, reason: unknown, level: DiagnosticLevel = "error"): SafeDiagnostic {
  const error = errorParts(reason);
  const bridge = getDesktopBridge();
  const stage = source === "react-render" ? "react-initialization" : currentStartupStage;
  return {
    id: "WA-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomUUID().slice(0, 6).toUpperCase(),
    timestamp: new Date().toISOString(),
    level,
    source: cleanText(source, 80),
    name: cleanText(error.name, 80),
    message: cleanText(error.message, MAX_MESSAGE_LENGTH),
    stack: stackSummary(error.stack),
    appVersion: bridge?.appVersion ?? process.env.NEXT_PUBLIC_WEALTH_ATLAS_VERSION ?? "unknown",
    electronVersion: bridge?.electronVersion ?? "browser",
    platform: bridge?.platform ?? (typeof navigator === "undefined" ? "unknown" : navigator.platform),
    mode: bridge?.isDesktop ? "desktop-production" : "web",
    stage,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

export async function reportSafeDiagnostic(source: string, reason: unknown, level: DiagnosticLevel = "error") {
  const diagnostic = createSafeDiagnostic(source, reason, level);
  try { await getDesktopBridge()?.reportDiagnostic(diagnostic); }
  catch { /* Diagnostics must never become another application failure. */ }
  return diagnostic;
}

export function formatDiagnostic(diagnostic: SafeDiagnostic) {
  return [
    "Wealth Atlas " + diagnostic.appVersion,
    "Schema version: " + diagnostic.schemaVersion,
    "Error ID: " + diagnostic.id,
    "Time: " + diagnostic.timestamp,
    "Error: " + diagnostic.name + ": " + diagnostic.message,
    "Electron: " + diagnostic.electronVersion,
    "Platform: " + diagnostic.platform,
    "Mode: " + diagnostic.mode,
    "Startup stage: " + diagnostic.stage,
    diagnostic.stack ? "Stack:\n" + diagnostic.stack : "Stack: unavailable",
  ].join("\n");
}
