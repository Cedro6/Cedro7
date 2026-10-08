import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@bos/db"],
  serverExternalPackages: ["pg"],
};

export default config;
