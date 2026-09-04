# AGENTS.md — Cortar y Ordenar Facturas

Frontend-only, sin backend. TypeScript + Vite. Solo Chrome/Chromium en desktop.

## Comandos (pnpm, no npm)

```bash
pnpm install    # instalar
pnpm dev        # dev server, abre Chrome solo (server.open)
pnpm test       # vitest run (103 tests P0+P1, ~2s)
pnpm typecheck  # tsc --noEmit
pnpm build      # build prod → dist/
pnpm preview    # previsualizar el build
```

Hay linter (Oxlint, `pnpm lint`) y CI (GitHub Actions: lint + typecheck + test + build en cada PR). Verificar con `pnpm lint`, `pnpm test` y `pnpm typecheck` (y `pnpm build` si toca config de Vite).

## Arquitectura

```
index.html          # DOM estático = contrato (sidebar, modales, #sheets). JS solo renderiza sheets
src/main.ts         # bootstrap: cargar() → init* → renders. Entrada única
src/types.ts        # tipos de dominio (Comprobante, Hoja, EstadoApp). Solo tipos
src/state.ts        # estado global + localStorage + ops puras (redistribuir, limpiarHojas)
src/ui/             # layout, sidebar, sheets, monto, ocrMode, settingsModal
src/pipeline/       # solo queue.ts (MOCK con sleep 900ms + valores ejemplo). crop/ocr/pdf/extract no existen aún
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
