import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@bos/db", "@bos/core"],
  serverExternalPackages: ["pg"],
};

export default config;
