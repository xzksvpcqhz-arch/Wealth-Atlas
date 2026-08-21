import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import RuntimeDiagnostics, { DiagnosticBoundaryProbe } from "@/components/RuntimeDiagnostics";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });

export const metadata: Metadata = {
  title: "Wealth Atlas | 个人财富星图",
  description: "本地优先的个人财富管理控制台",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className={spaceGrotesk.variable}>
      <body><RuntimeDiagnostics /><AppErrorBoundary><DiagnosticBoundaryProbe />{children}</AppErrorBoundary></body>
    </html>
  );
}
