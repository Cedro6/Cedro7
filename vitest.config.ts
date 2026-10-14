import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/tests/**/*.test.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL_OWNER:
        process.env.TEST_DATABASE_URL_OWNER ?? "postgres://bos_owner:bos_owner@localhost:5432/bos_test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://bos_app:bos_app@localhost:5432/bos_test",
    },
  },
});
