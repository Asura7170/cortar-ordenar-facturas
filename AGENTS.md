# AGENTS.md — Cortar y Ordenar Facturas

Frontend-only, sin backend. TypeScript + Vite+ (toolchain VoidZero: Vite 8, Vitest, Oxlint, Oxfmt). Solo Chrome/Chromium en desktop.

## Comandos (pnpm, no npm; `vp` donde aplique)

```bash
vp install      # instalar (delega a pnpm 12, fijado en devEngines)
pnpm dev        # vp dev --open: dev server, abre Chrome solo (server.open)
pnpm test       # vp test run (~740 tests, ~7s)
pnpm typecheck  # tsc --noEmit
vp check        # lint + formato + tipos (válido para loops de validación)
pnpm check      # ultracite check: lint + formato del preset (0 errores desde 2026-11)
pnpm build      # vp build: build prod → dist/
pnpm preview    # vp preview: previsualizar el build
```

Hay CI (GitHub Actions: `vp check` + typecheck + test + build en cada PR, job `check` requerido por el ruleset). Verificar con `vp check`, `pnpm check`, `pnpm test` y `pnpm typecheck` (y `pnpm build` si toca config de Vite).

- Tests viajan solo por `vp` (sin `vitest` standalone: `vite-plus` lo embutea y `vp test`/`test:coverage` usan esa copia). `@vitest/coverage-v8` + `jsdom` sí quedan en devDeps porque vp los resuelve desde la raíz; NO quitarlos. Llamar siempre vía `pnpm exec vp` o scripts (un `vp` global aparte daría otra versión).
- `vite`/`vite-plus`/`@vitest/coverage-v8` se resuelven vía `catalog:` en `pnpm-workspace.yaml` (no tocar los alias; pnpm los necesita para que el override aplique). Bump de vite-plus **manual**: las dos entradas del catálogo deben ir en la misma versión o `vp build` aborta, y dependabot solo bumpea una. `overrides.vitest@*` apunta al catálogo y lo mantiene lockstep con el vitest embuteado (ver el comentario en el archivo); `@vitest/coverage-v8` también va lockstep porque el guard de coverage de vp exige la versión exacta.
- `onnxruntime-web` 1.31.1 pineado en dependencies (única dep nueva; trae `protobufjs`, permitido en `allowBuilds`). EPs `webgpu`→`wasm` con `numThreads: 1` (los workers pthread los bloquea Chrome bajo COEP; single-thread ~250ms/foto basta); `ort.env.wasm.wasmPaths` apunta a `public/ort/` en dev y al CDN pineado en PROD (el .wasm supera el límite de Pages).
- `MODELOS_VERSION` en `docaligner.ts`: al cambiar `public/models/ocr/*.onnx` o re-subir los pesos HF, subirla +1 en el mismo PR — la caché de navegadores (Cache Storage "modelos") se invalida por el marcador `?modelos_v=N` de la clave en la **query** (el matching de Cache Storage excluye los fragmentos `#`: verificado en Chrome, `#v1` y `#v2` colapsan); sin bump, los usuarios viejos sirven pesos viejos para siempre. La IA muerta se recupera sola: 2 fallos de sesión seguidos = expulsión de la clave + latch suelto, y la red fallida entra en enfriamiento de 60s (botón "Probar IA" en Ajustes lo resetea).
- Imports: `vite-plus` en config, `vite-plus/test` en tests. Regla `vite-plus/prefer-vite-plus-imports` lo exige (`vp check` falla si importas de `vite`/`vitest`).
- `.vite-hooks/` (pre-commit `vp staged`) se commitea; `prepare: vp config` lo activa tras instalar.

## Lint del preset (Ultracite / Oxlint)

`pnpm check` dio 0 el 2026-11-19 y es gate de lint junto a `vp check`. La política es global en `oxlint.config.mts`: cada regla fuera del preset lleva un `ponytail:` al lado. Las excepciones puntuales van por línea (`oxlint-disable-next-line` con su razón); prohibidos `-A` global y los silencios por archivo.

- **Configuradas con opción:** `eqeqeq` (`null: "ignore"`; `no-eq-null` off), `no-use-before-define` (`functions: false, variables: false`; las clases siguen protegidas), `consistent-type-imports` (`disallowTypeAnnotations: false`), `no-array-sort` (`allowAfterSpread`), `no-warning-comments` (`fixme`, `xxx`), `complexity` (30). `require-await` y `max-classes-per-file` van off solo en `**/*.test.ts`.
- **Rechazadas:** `func-style` (hoisting, recursión mutua, `isolatedDeclarations`), `prefer-to-be-truthy`/`prefer-to-be-falsy` (debilitan `toBe(true/false)`), `prefer-query-selector` (contrato `getEl`/`getElementById`), `filename-case` (camelCase español), `promise/avoid-new`/`prefer-await-to-callbacks`/`param-names` (APIs DOM con callbacks), `no-await-in-loop` (cola OCR secuencial), `consistent-function-scoping` (closures), `max-expects`/`require-top-level-describe` (tests de integración por archivo), `no-empty-function` (mocks y no-ops), `prefer-spread` (rompe `ArrayBuffer`), `prefer-dom-node-dataset` (rompe tipos), `prefer-spy-on` (stubs no restaurables), `prefer-describe-function-title`/`prefer-import-in-mock`/`prefer-called-with` (rompen tipos o cambian/debilitan aserciones).
- **Allowlist de autofix** (solo fixes neutros, por regla y nunca `--fix` global): `catch-error-name`, `numeric-separators-style`, `array-type`, `prefer-at`, `prefer-number-properties`, `switch-case-braces`, `no-zero-fractions`, `prefer-string-replace-all`, `consistent-existence-index-check`, `no-useless-undefined` (`checkArguments: false`), `require-array-join-separator`, `new-for-builtins`, `prefer-dom-node-append`, `import/newline-after-import`, `vitest/padding-around-test-blocks`, `vitest/consistent-test-it`, `vitest/prefer-mock-return-shorthand`, `one-var` (`never`), `operator-assignment`, `func-names`, `vitest/prefer-expect-resolves`, `vitest/prefer-called-once`, `vitest/prefer-to-have-length`. Vetadas: `prefer-spread`, `prefer-dom-node-dataset`, `prefer-query-selector`, `no-array-sort`, `require-await`, `prefer-spy-on`, `prefer-called-with`, `prefer-describe-function-title`.

## CRAP local (crapper: solo local, sin job de CI)

La disciplina CRAP vive fuera del CI (job check requerido por el ruleset: solo `vp check`/typecheck/test/build). Medir local YA:

```bash
pnpm exec vp test run --coverage
C:/Users/kevin/Downloads/Curso_Frontend/tools-crapper/.venv/Scripts/python -m crapper --root . -s src --use-existing-coverage --threshold 15
```

- **Regla: el peor CRAP debe quedar < 15** (ofensor solo si supera 15: no "pulir" funciones que ya cumplen). exit 0 = verde; exit 2 = hay ofensores, y el reporte del stdout los lista worst-first. `.metrics/crap.edn` (gitignored) queda actualizado con la medición.
- Si algo supera 15: playbook de los lotes 1-10 — tests nuevos verdes contra el código ORIGINAL antes de tocar, split minimal-diff en helpers (cuerpo verbatim, `ponytail:` para las podas con prueba de imposibilidad), y medir tras cada bloque.
- El binario vive en una venv fuera del repo (`tools-crapper`, pineado a `unclebob/crapper@9f1bead`): no commitear, no invocarlo desde CI.

## Arquitectura

```
index.html          # DOM estático = contrato (sidebar, modales, #sheets). JS solo renderiza sheets
src/main.ts         # bootstrap: cargar() → init* → renders. Entrada única
src/types.ts        # tipos de dominio (Comprobante, Hoja, EstadoApp). Solo tipos
src/state.ts        # estado global + localStorage + ops puras (redistribuir, limpiarHojas)
src/ui/             # layout, sidebar, sheets, monto, ocrMode, settingsModal, github, recorte
src/pipeline/       # docaligner.ts (DocAligner heatmap/fastvit_sa24 + borde negro 100px + warp canvas, fallback completa; EPs con timeout 30s + latch, nunca cuelga la cola) + queue.ts (recorte real + OCR real; re-chequeo regex al drenar) + pdf.ts (gate PDF ≤10p/≤5MB con aviso + fan-out 1 página=1 comprobante, omite blancas/negras) + ocr.ts (det+rec+enderezar reales) + extract.ts (regex offline: 1 distinto = total; ≥2 distintos o signo previo queda manual; monto manual suma) + imagen.ts + ocrDb/ocrRec/ocrDict.ts + rotar.ts
src/export/salidas.ts  # Word real (docx: N-up flotante + footer) + PDF/Imprimir vía zonaPrint (printEnVuelo); gate y nombre comunes
spec.md             # spec del pipeline objetivo (DocAligner → PP-OCRv6_small ONNX → regex → docx). Fuente de verdad del diseño
public/models/      # fastvit_sa24_h_e_bifpn_256_fp32.onnx + ocr/det.onnx + ocr/rec.onnx vendoreados (Apache-2.0) + NOTICE.txt. No va por CDN (COEP require-corp)
public/ort/         # par asyncify onnxruntime-web copiado de node_modules (el build webgpu lo exige; los nombres cambian por minor). Excluido de formato (.prettierignore). En dev lo sirve en crudo el middleware servir-ort-crudo (vite prohíbe import() desde /public)
```

- Estado: `state.hojas` (no persiste) + persistido en `localStorage["libro-mayor-state"]` (solo codigoActivo/Longitud/Valor/Posicion, moneda). Tema aparte en `libro-mayor-tema`.
- Montos siempre en **cents enteros** (`Cents`), nunca float. Suma/formato en `src/ui/monto.ts`.
- `getEl(id)` en `src/utils.ts` falla fuerte si falta el id: si agregas un id en JS, créalo en `index.html`.
- `vite.config.ts` envía COOP/COEP (necesarios para WASM con threads). No quitar los headers ni servir con `python -m http.server` (no los envía).

## TypeScript estricto (rompe el build si lo ignoras)

`verbatimModuleSyntax` → usa `import type` para tipos. `erasableSyntaxOnly` → prohibidos enums, namespaces y parameter properties. `isolatedDeclarations` → toda función exportada lleva tipo de retorno explícito. Además: `noUncheckedIndexedAccess` (indexar arrays da `T | undefined`), `exactOptionalPropertyTypes`, `moduleDetection: force` (todo módulo necesita al menos un import/export).

## Chrome-first — sin retrocompatibilidad, sin mobile

Solo Chrome/Chromium desktop. Se vale usar lo más moderno disponible en Chrome (`<dialog closedby>`, `command`/`commandfor`, Popover, `:has()`, nesting, `Promise.withResolvers`, `Iterator.from`, etc.). Prohibido: fallbacks, polyfills, `@supports`, prefijos vendor y media queries responsive/mobile. Si no está en Chrome, no se usa.

## Convenciones

- `type="module"`, `const` por defecto. Código en español (ids, comentarios, UI).
- Comentarios `ponytail:` marcan simplificaciones deliberadas — no "arreglarlos" sin motivo.
- `docs/` e `image-test/` están en `.gitignore` (referencia/scratch local): no commitear ni importar desde ahí, salvo `docs/agents/` y `docs/adr/`, que se versionan.
- **NUNCA tocar el zoom de la GUI/TUI de Orca** (el programa en el que se trabaja): ni `Ctrl±/0`, ni rueda+tecla, ni menús del host — al hacer zoom sobre la pestaña activa de Orca se escapa el zoom del programa completo y arruina la sesión del usuario. El "zoom" de test solo va a la PÁGINA abierta: zoom nativo del chromium del browser embebido actuando sobre el documento (CSS `zoom` en la página) o viewport; jamás la superficie host. Si el atajo no está garantizado para la página, NO se envía: se cambia de método.
- Prohibido `git commit`, `push`, `merge`, crear PRs o reescribir historial (`--force`, `reset --hard`) sin petición explícita del usuario en el prompt. Sin esa orden, los cambios quedan sin commitear.

## Agent skills

### Issue tracker

Issues y specs viven como markdown local en `docs/<feature>/` (gitignored). Ver `docs/agents/issue-tracker.md`.

### Triage labels

Los cinco roles canónicos usan sus nombres por defecto (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Ver `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` en la raíz y `docs/adr/` para decisiones. Ver `docs/agents/domain.md`.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm exec ultracite fix`
- **Check for issues**: `pnpm exec ultracite check`
- **Diagnose setup**: `pnpm exec ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Write functions as arrow functions assigned to `const`, and define them above where they're used
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- When a hook dependency rule fires, first check whether the effect is needed, and whether adding the dependency changes when it runs
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components

### Accessibility

- Use semantic HTML first; add ARIA only when no native element fits
- Provide meaningful alt text for images
- Use proper heading hierarchy
- Add labels for form inputs
- Make anything clickable a `<button>` or a link, so it works from the keyboard; don't add key handlers to a `<div>`
- Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns
- Avoid import cycles; move shared code into a module both sides import
- Don't leave TODO or FIXME comments in new code. For an existing one, do the task, delete it if it's done, or leave it; never reword it to get past the linter

### Security

- Add `rel="noopener noreferrer"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Avoid barrel files (index files that only re-export other modules) inside an app; a package's entry point is fine
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt will catch most mechanical issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

En este repo el formato lo aplica `vp check --fix`; no corras `ultracite fix` a ciegas: sus autofixes de lint rompieron tipos y tests (ver `oxlint.config.mts`). `vp check` es el gate de formato+tipos y `pnpm check` también es gate: el CI corre ambos en el job requerido.
