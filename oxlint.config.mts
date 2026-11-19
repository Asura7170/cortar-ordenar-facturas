import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// ponytail: la deuda del preset está en 0; `pnpm check` es gate de lint junto a
// `vp check`. Cada regla que sale del preset lleva su razón al lado; nada de
// `-A` global ni `eslint-disable` de archivo.
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
  rules: {
    // ponytail: `x != null` estrecha undefined bajo noUncheckedIndexedAccess sin perder el 0.
    eqeqeq: ["error", "always", { null: "ignore" }],
    // ponytail: cubierto por eqeqeq `null: "ignore"`; juntos se contradicen.
    "no-eq-null": "off",
    // ponytail: 46 funciones con hoisting y 16 `let` de módulo usados en closures; las clases siguen protegidas.
    "no-use-before-define": ["error", { functions: false, variables: false }],
    // ponytail: `import()` en posición de tipo se borra con verbatimModuleSyntax.
    "typescript/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
    // ponytail: ordenar copias con spread es seguro; los literales frescos pasan a toSorted().
    "unicorn/no-array-sort": ["error", { allowAfterSpread: true }],
    // ponytail: "todo" en español no es un marcador; fixme/xxx siguen vigilados.
    "no-warning-comments": ["error", { terms: ["fixme", "xxx"] }],
    // ponytail: las 2 funciones medidas están en 21-29; el umbral 20 no aporta.
    complexity: ["error", 30],
  },
  overrides: [
    {
      files: ["**/*.test.ts"],
      rules: {
        // ponytail: mocks que implementan () => Promise<T> no tienen await propio.
        "require-await": "off",
        // ponytail: los fixtures declaran varias clases a propósito.
        "max-classes-per-file": "off",
      },
    },
  ],
});
