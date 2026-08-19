"use client";

import { useEffect } from "react";
import { reportSafeDiagnostic, reportStartupStage } from "@/lib/diagnostics";

export default function RuntimeDiagnostics() {
  useEffect(() => {
    void reportStartupStage("react-initialization", "success");
    const handleError = (event: ErrorEvent) => {
      const error = event.error instanceof Error ? event.error : new Error(event.message || "Window error");
      void reportSafeDiagnostic("window.onerror", error);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      void reportSafeDiagnostic("unhandledrejection", event.reason);
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);
  return null;
}

export function DiagnosticBoundaryProbe() {
  if (typeof window !== "undefined" && window.wealthAtlasDesktop?.isDiagnosticTest) {
    throw new Error("Startup boundary diagnostic test");
  }
  return null;
}
