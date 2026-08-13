/** @type {import('next').NextConfig} */
const isDesktopBuild = process.env.WEALTH_ATLAS_DESKTOP_BUILD === "1";

const nextConfig = {
  reactStrictMode: true,
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
