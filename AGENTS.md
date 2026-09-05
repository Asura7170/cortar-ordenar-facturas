# AGENTS.md — Cortar y Ordenar Facturas

Frontend-only, sin backend. TypeScript + Vite+ (toolchain VoidZero: Vite 8, Vitest, Oxlint, Oxfmt). Solo Chrome/Chromium en desktop.

## Comandos (pnpm, no npm; `vp` donde aplique)

```bash
vp install      # instalar (delega a pnpm 11, fijado en devEngines)
pnpm dev        # vp dev --open: dev server, abre Chrome solo (server.open)
pnpm test       # vitest run local (110 tests, ~2s). Ver NOTA abajo: NO usar `vp test`
pnpm typecheck  # tsc --noEmit
vp check        # lint + formato + tipos (válido para loops de validación)
pnpm build      # vp build: build prod → dist/
pnpm preview    # vp preview: previsualizar el build
```

Hay CI (GitHub Actions: `vp check` + typecheck + test + build en cada PR, job `check` requerido por el ruleset). Verificar con `vp check`, `pnpm test` y `pnpm typecheck` (y `pnpm build` si toca config de Vite).

- NOTA (`ponytail:` divergencia deliberada del toolchain): `vp test` está roto en vp 0.3.0 con pnpm — su vitest interno no resuelve el peer opcional `jsdom` (`Cannot find package 'jsdom'`, environment de los tests). Por eso `test`/`test:watch` usan el binario `vitest` local (dep explícita) en vez de `vp test`. Revertir a `vp test` cuando upstream lo arregle.
- `vite`/`vite-plus`/`vitest` se resuelven vía `catalog:` en `pnpm-workspace.yaml` (no tocar los alias; pnpm los necesita para que el override aplique).
- Imports: `vite-plus` en config, `vite-plus/test` en tests. Regla `vite-plus/prefer-vite-plus-imports` lo exige (`vp check` falla si importas de `vite`/`vitest`).
- `.vite-hooks/` (pre-commit `vp staged`) se commitea; `prepare: vp config` lo activa tras instalar.

## Arquitectura

```
index.html          # DOM estático = contrato (sidebar, modales, #sheets). JS solo renderiza sheets
src/main.ts         # bootstrap: cargar() → init* → renders. Entrada única
src/types.ts        # tipos de dominio (Comprobante, Hoja, EstadoApp). Solo tipos
src/state.ts        # estado global + localStorage + ops puras (redistribuir, limpiarHojas)
src/ui/             # layout, sidebar, sheets, monto, ocrMode, settingsModal
src/pipeline/       # queue.ts (MOCK con sleep 900ms + valores ejemplo) + pdf.ts (gate PDF ≤10p/≤5MB con aviso + fan-out 1 página=1 comprobante, omite blancas). crop/ocr/extract no existen aún
src/export/docx.ts  # STUB: descarga .txt con nombre final. docx.js real va acá
spec.md             # spec del pipeline objetivo (OpenCV → PaddleOCR → LLM → docx). Fuente de verdad del diseño
```

- Estado: `state.hojas` (no persiste) + persistido en `localStorage["libro-mayor-state"]` (solo codigoActivo/Longitud/Valor, moneda, configIA). Tema aparte en `libro-mayor-tema`.
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
- `docs/` e `image-test/` están en `.gitignore` (referencia/scratch local): no commitear ni importar desde ahí.
- API key del LLM vive solo en localStorage (form Ajustes). Nunca al repo.
- Prohibido `git commit`, `push`, `merge`, crear PRs o reescribir historial (`--force`, `reset --hard`) sin petición explícita del usuario en el prompt. Sin esa orden, los cambios quedan sin commitear.
- Tras actualizar un PR existente (push nuevo a su rama), como ÚLTIMO paso comentar `@coderabbitai review` en el PR para activar el review de CodeRabbit (obligatorio, sin excepciones). No aplica al crear el PR: CodeRabbit ya revisa la creación automáticamente.
