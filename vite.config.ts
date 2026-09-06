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
});
