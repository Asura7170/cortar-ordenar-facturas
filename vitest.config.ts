import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      exclude: [
        "public/ort/**",
        "public/models/**",
        "**/*.test.ts",
        "**/test/**",
        "**/*.d.ts",
        "dist/**",
        // Sin runtime que cubrir: main es bootstrap con side-effects al importar
        // (cubierto indirectamente vía init*), types solo declara tipos.
        "src/main.ts",
        "src/types.ts",
      ],
      thresholds: { lines: 85, statements: 80 },
    },
  },
});
