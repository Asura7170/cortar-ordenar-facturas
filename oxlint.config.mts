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

    // --- Rechazos: pelean con el repo o debilitan aserciones ---
    // ponytail: 552 declaraciones con hoisting/recursión mutua; pasarlas a arrow exige reordenar y rompe isolatedDeclarations.
    "func-style": "off",
    // ponytail: getEl/getElementById es el contrato que falla fuerte si falta el id.
    "unicorn/prefer-query-selector": "off",
    // ponytail: convención camelCase española; renombrar rompe imports e historial.
    "unicorn/filename-case": "off",
    // ponytail: la API DOM (onload, FileReader, rAF) es callback; envolverla en new Promise es lo correcto.
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/param-names": "off",
    // ponytail: la cola OCR es secuencial por diseño (sesión ONNX y memoria).
    "no-await-in-loop": "off",
    // ponytail: mover funciones fuera del scope rompe closures.
    "unicorn/consistent-function-scoping": "off",
    // ponytail: los no-ops son mocks deliberados.
    "no-empty-function": "off",
    // ponytail: el fix de spread convierte un ArrayBuffer en array (TypeError en runtime).
    "unicorn/prefer-spread": "off",
    // ponytail: el fix de dataset rompe los tipos de getAttribute.
    "unicorn/prefer-dom-node-dataset": "off",
  },
  overrides: [
    {
      // ponytail: declarar el plugin aquí es lo que permite apagar sus reglas; el preset vitest las fija en su propio override.
      files: ["**/*.test.ts"],
      plugins: ["vitest"],
      rules: {
        // ponytail: mocks que implementan () => Promise<T> no tienen await propio.
        "require-await": "off",
        // ponytail: los fixtures declaran varias clases a propósito.
        "max-classes-per-file": "off",
        // ponytail: comparan booleanos reales; toBeTruthy/toBeFalsy debilitan la aserción.
        "vitest/prefer-to-be-truthy": "off",
        "vitest/prefer-to-be-falsy": "off",
        // ponytail: tests de integración con varias aserciones; los describe ya se organizan por archivo.
        "vitest/max-expects": "off",
        "vitest/require-top-level-describe": "off",
        // ponytail: los stubs por asignación no se restauran con spyOn.
        "vitest/prefer-spy-on": "off",
        // ponytail: títulos de comportamiento; el fix exige refs y rompe tipos.
        "vitest/prefer-describe-function-title": "off",
        // ponytail: factory parcial de vi.mock; importar el real ejecuta efectos de módulo.
        "vitest/prefer-import-in-mock": "off",
        // ponytail: toHaveBeenCalledWith() sin args cambia la aserción y rompió 5 tests.
        "vitest/prefer-called-with": "off",
      },
    },
  ],
});
