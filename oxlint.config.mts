import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// ponytail: preset aspiracional. `pnpm check` lista la deuda de esta base; el
// gate de CI sigue siendo `vp check` (bloque `lint` de vite.config.ts). Revisar
// el diff de `ultracite fix` antes de commitear: sus fixes de Oxlint rompieron
// tipos y tests aquí (spread de ArrayBuffer, `it` sin importar, dataset).
export default defineConfig({
  env: core.env,
  extends: [core, vitest],
  // ponytail: upstream vendoreado y scratch local fuera del lint (mismo set que .prettierignore).
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "public/ort/**",
    "public/fonts/**",
    "public/models/ocr/**",
    "modelos-fuente/**",
    "src/pipeline/ocrDict.ts",
    "docs/**",
    "image-test/**",
    "**/*.md",
  ],
});
