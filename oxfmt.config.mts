import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // ponytail: el repo ya vive a 100 columnas y con trailing comma "all" (lo que
  // aplica vp); 80/es5 solo generarían un reformat masivo y guerra de formatos.
  printWidth: 100,
  trailingComma: "all",
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
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
