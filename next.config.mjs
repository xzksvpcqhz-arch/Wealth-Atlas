import packageJson from "./package.json" with { type: "json" };

/** @type {import('next').NextConfig} */
const isDesktopBuild = process.env.WEALTH_ATLAS_DESKTOP_BUILD === "1";
const isWebExport = process.env.WEALTH_ATLAS_WEB_EXPORT === "1";
const isStaticExport = isDesktopBuild || isWebExport;

const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_WEALTH_ATLAS_VERSION: packageJson.version },
  ...(isStaticExport
    ? {
        output: "export",
        trailingSlash: true,
        images: { unoptimized: true },
        // 桌面端用相对路径（file:// 打开）；Web/Cloudflare 用绝对路径。
        ...(isDesktopBuild ? { assetPrefix: "." } : {}),
      }
    : {}),
};

export default nextConfig;
