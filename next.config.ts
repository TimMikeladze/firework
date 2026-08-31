import type { NextConfig } from "next";

/**
 * `.wgsl` files are compiled by the vgpu loader, which resolves their
 * `import`/`export` graph at build time. Turbopack and webpack each need their
 * own registration, and Next reads only the one matching the active bundler.
 */
const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
  webpack(config) {
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.push({
      test: /\.wgsl$/,
      loader: "@vgpu/wgsl/loader-webpack",
    });
    return config;
  },
};

export default nextConfig;
