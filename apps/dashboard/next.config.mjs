/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: hosted as plain files (no CloudFront/SSR runtime needed).
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@scrapeforge/shared-types", "@scrapeforge/sdk"],
}

export default nextConfig
