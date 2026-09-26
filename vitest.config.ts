import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["public/ort/**", "public/models/**", "**/*.test.ts", "**/test/**", "dist/**"],
      thresholds: { lines: 85, statements: 80 },
    },
  },
});
