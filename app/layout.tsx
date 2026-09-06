import type { Metadata } from "next";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import RuntimeDiagnostics, { DiagnosticBoundaryProbe } from "@/components/RuntimeDiagnostics";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wealth Atlas | 个人财富星图",
  description: "本地优先的个人财富管理控制台",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Wealth Atlas", statusBarStyle: "black-translucent" },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><RuntimeDiagnostics /><AppErrorBoundary><DiagnosticBoundaryProbe />{children}</AppErrorBoundary></body>
    </html>
  );
}
