import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineConfig } from "vite-plus";

// COOP/COEP: necesarios para onnxruntime-web WASM con threads (y futuro PaddleOCR).
// server.open: abre el navegador en `pnpm dev`. build → dist/.
export default defineConfig({
  plugins: [
    {
      name: "servir-ort-crudo",
      // ponytail: vite-dev prohíbe import() desde /public y ORT 1.29 carga su
      // glue .mjs con import(); se sirve en crudo solo en dev (build/preview
      // sirven public/ verbatim, sin transform).
      configureServer(servidor) {
        servidor.middlewares.use((pet, res, sig) => {
          const url = pet.url ?? "";
          if (!url.startsWith("/ort/")) {
            sig();
            return;
          }
          const base = url.split("/").pop()?.split("?")[0] ?? "";
          // ponytail: basename estricto — ni `\` (separador Windows) ni query-trucos salen de public/ort.
          if (!/^[\w.-]+\.mjs$/.test(base)) {
            sig();
            return;
          }
          readFile(join(process.cwd(), "public", "ort", base))
            .then((bytes) => {
              res.setHeader("Content-Type", "text/javascript");
              res.end(bytes);
            })
            .catch(() => sig());
        });
      },
    },
  ],
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    // ponytail: glue asyncify vendoreado (upstream) — fuera del lint, como del formato.
    ignorePatterns: ["public/ort/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  server: {
    open: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
  // ponytail: config de tests en el mismo vite.config (recomendación de vp:
  // "We do not recommend using vitest.config.ts with Vite+"). `vp test` lee
  // el bloque `test` de aquí; el archivo vitest.config.ts se eliminó.
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
