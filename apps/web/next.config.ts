import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@bos/db", "@bos/core"],
  serverExternalPackages: ["pg"],
  // The state forms are read from disk at request time, so they must ship with the server.
  outputFileTracingIncludes: { "/deals/[id]/forms/[form]": ["./forms/florida/*.pdf"] },
};

export default config;
