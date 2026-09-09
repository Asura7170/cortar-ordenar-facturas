# Cortar y Ordenar Facturas

Frontend-only, Chrome desktop-only. Fotos/PDFs → recorte DocAligner + OCR PP-OCRv6_small + suma con LLM → hojas carta → Word real (.docx).

## Requisitos

- Chrome latest en desktop (usa WASM, SharedArrayBuffer, `<dialog closedby>`, etc.)
- `node ^20.19.0 || ^22.18.0 || >=24.11.0` + `pnpm 11` (ver `devEngines`)
- Servir con COOP/COEP (lo pone `vite.config.ts`). No usar `file://` ni `python -m http.server`.

## Instalación

```bash
vp install      # pnpm 11 + vp config (activa .vite-hooks/)
pnpm dev        # vp dev --open, abre Chrome
```

## Comandos

| Comando          | Qué hace                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `pnpm dev`       | dev + abre Chrome                                                                             |
| `pnpm test`      | `vitest run` local. `ponytail: vp test` roto en vp 0.3.0 (`Cannot find jsdom`) → usar binario |
| `pnpm typecheck` | `tsc --noEmit` estricto                                                                       |
| `vp check`       | lint + formato + tipos (exige imports de `vite-plus`)                                         |
| `pnpm build`     | `vp build` → `dist/`                                                                          |
| `pnpm preview`   | previsualizar build                                                                           |

CI exige `vp check + typecheck + test + build` en cada PR.

## Uso

1. Pegar (`Ctrl+V`), arrastrar o clic en dropzone. Formatos: `jpg/png/webp/bmp/gif/pdf`.
2. PDF: cada archivo se evalúa solo, entra si `≤5 MB` y `≤10 páginas`. Cada página no-blanca = 1 comprobante; blancas se omiten. Protegido/ilegible → aviso sin romper cola.
3. `HEIC` → aviso `formato no soportado`, no falla la cola.
4. La cola recorta + endereza + OCR sola. Botón `Extraer montos (btnIA)` fuerza lote; al drenar se auto-lanza si hay IA configurada.
5. Giro manual `±90°` por tarjeta (debounce 1500ms, relee OCR). Monto manual en tarjeta siempre gana y sí suma.
6. Arrastre libre dentro de cada hoja (posición física, no cambia orden de inserción). `M`=lupa, `Esc`=soltar, `Ctrl++/−/0`=zoom. `X` elimina comprobante.

## Config IA

Ajustes (`btnAjustes`): `baseURL`, `model`, `apiKey` (solo localStorage, nunca al repo), `moneda` (`USD/ARS/EUR/BOB`, default `USD`).

Default: Groq `https://api.groq.com/openai/v1/chat/completions` + `qwen/qwen3.8-27b`. Sin config → monto manual.

## Salidas

Gate común: `codigoValido()` (si check activo, N dígitos completos) + `≥1` comprobante. Si no → se bloquea + mensaje.

Nombre: `{codigo}-comprobante.{docx|pdf}` (`sincodigo-` sin código).

- **Word:** `docx` flotantes EMU + `wrap SQUARE`, código en header/footer según esquina elegida (default inf-der).
- **PDF / Imprimir:** misma vista carta, `window.print()` + `@media print` + `@page` carta, full-res.

## Límites

`lado max 2000px`, `JPEG 0.9`, `det 960px`, `DocAligner 256px + borde 100px`, `EP 30s webgpu→wasm single-thread`, `LLM 60s / 1800 chars por item / 25 items`, `miniaturas 800/720px`.

## Troubleshooting

- `SharedArrayBuffer` / pantalla negra: revisa COOP/COEP (solo `pnpm dev`/`preview`, no otro server).
- `ORT sin proveedor`: primer EP con timeout 30s + latch, reintenta con wasm; revisa `public/ort/` servido.
- `LLM CORS/key`: revisa `baseURL`, key en Ajustes, y consola (timeout 60s).
- `vp test` falla con `jsdom`: usa `pnpm test` (binario local).
- `dist` >1MB: build es solo-webgpu a propósito.

## Licencias

- Modelos vendoreados: ver `public/models/NOTICE.txt` (DocAligner Apache-2.0, PaddleOCR PP-OCRv6 Apache-2.0, geometría MIT).
- Deps runtime: `onnxruntime-web` MIT, `pdfjs-dist` Apache-2.0 (`^6.3.289` flotante deliberado), `docx` MIT, `vite-plus` MIT.

## Spec

Ver [spec.md](./spec.md) (fuente técnica, manda sobre `PRODUCT.md`).
