import type { Metadata } from "next";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import RuntimeDiagnostics, { DiagnosticBoundaryProbe } from "@/components/RuntimeDiagnostics";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wealth Atlas | 个人财富星图",
  description: "本地优先的个人财富管理控制台",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><RuntimeDiagnostics /><AppErrorBoundary><DiagnosticBoundaryProbe />{children}</AppErrorBoundary></body>
    </html>
  );
}
