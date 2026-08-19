import packageJson from "./package.json" with { type: "json" };

/** @type {import('next').NextConfig} */
const isDesktopBuild = process.env.WEALTH_ATLAS_DESKTOP_BUILD === "1";

const nextConfig = {
  reactStrictMode: true,
  env: { NEXT_PUBLIC_WEALTH_ATLAS_VERSION: packageJson.version },
  ...(isDesktopBuild
    ? {
        output: "export",
        assetPrefix: ".",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
