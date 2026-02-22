import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // All test files share one Redis DB, so FLUSHDB in one file
    // would wipe another file's data if they ran in parallel.
    fileParallelism: false,
  },
});
