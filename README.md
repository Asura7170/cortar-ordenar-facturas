# Cortar y Ordenar Facturas

Frontend-only, Chrome desktop-only. Fotos/PDFs → recorte DocAligner + OCR PP-OCRv6_small + extracción del total por regex → hojas carta → Word real (.docx).

## Requisitos

- Chrome latest en desktop (usa WASM, SharedArrayBuffer, `<dialog closedby>`, etc.)
- `node ^22.18.0 || ^24.11.0 || >=26.0.0` + `pnpm 12` (ver `devEngines`)
- Servir con COOP/COEP (lo pone `vite.config.ts`). No usar `file://` ni `python -m http.server`.

## Instalación

```bash
vp install      # pnpm 12 + vp config (activa .vite-hooks/)
pnpm dev        # vp dev --open, abre Chrome
```

## Comandos

| Comando          | Qué hace                                              |
| ---------------- | ----------------------------------------------------- |
| `pnpm dev`       | dev + abre Chrome                                     |
| `pnpm test`      | `vp test run` (único runner, sin vitest standalone)   |
| `pnpm typecheck` | `tsc --noEmit` estricto                               |
| `vp check`       | lint + formato + tipos (exige imports de `vite-plus`) |
| `pnpm build`     | `vp build` → `dist/`                                  |
| `pnpm preview`   | previsualizar build                                   |

CI exige `vp check + typecheck + test + build` en cada PR.

## Uso

1. Pegar (`Ctrl+V`), arrastrar o clic en dropzone. Formatos: `jpg/png/webp/bmp/gif/pdf`.
2. PDF: cada archivo se evalúa solo, entra si `≤5 MB` y `≤10 páginas`. Cada página no-blanca = 1 comprobante; blancas se omiten. Protegido/ilegible → aviso sin romper cola.
3. `HEIC` → aviso `formato no soportado`, no falla la cola.
4. La cola recorta + endereza + OCR sola. El total se fija por regex (1 monto distinto); botón `Calcular totales (btnCalcular)` fuerza re-chequeo; lo ambiguo queda manual.
5. Giro manual `±90°` por tarjeta (debounce 1500ms, relee OCR). Monto manual en tarjeta siempre gana y sí suma.
6. Arrastre libre dentro de cada hoja (posición física, no cambia orden de inserción). `M`=lupa, `Esc`=soltar, `Ctrl++/−/0`=zoom. `X` elimina comprobante.

## Ajustes

Ajustes (`btnAjustes`): `moneda` (`USD/ARS/EUR/BOB`, default `USD`) y gestión de los modelos locales (descargar/borrar del caché del navegador). Sin backend: todo corre local.

## Salidas

Gate común: `codigoValido()` (si check activo, N dígitos completos) + `≥1` comprobante. Si no → se bloquea + mensaje.

Nombre: `{codigo}-comprobante.{docx|pdf}` (`sincodigo-` sin código).

- **Word:** `docx` flotantes EMU + `wrap SQUARE`, código en header/footer según esquina elegida (default inf-der).
- **PDF / Imprimir:** misma vista carta, `window.print()` + `@media print` + `@page` carta, full-res.

## Límites

`lado max 2000px`, `WebP 0.85` (passthrough jpg/png/webp intacto), `det 960px`, `DocAligner 256px + borde 100px`, `EP 30s webgpu→wasm single-thread`, grilla full-res con lazy (sin miniaturas).

## Troubleshooting

- `SharedArrayBuffer` / pantalla negra: revisa COOP/COEP (solo `pnpm dev`/`preview`, no otro server).
- `ORT sin proveedor`: primer EP con timeout 30s + latch, reintenta con wasm; revisa `public/ort/` servido en dev (en prod el wasm sale del CDN).
- `dist` >1MB: build es solo-webgpu a propósito.

## Licencias

- Modelos vendoreados: ver `public/models/NOTICE.txt` (DocAligner Apache-2.0, PaddleOCR PP-OCRv6 Apache-2.0, geometría MIT).
- Deps runtime: `onnxruntime-web` MIT, `pdfjs-dist` Apache-2.0 (`^6.4.299` flotante deliberado), `docx` MIT, `vite-plus` MIT.

## Spec

Ver [spec.md](./spec.md) (fuente técnica, manda sobre `PRODUCT.md`).
