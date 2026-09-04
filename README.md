# Cortar y Ordenar Facturas

App frontend-only para recortar comprobantes/facturas (OpenCV.js), extraer texto (PaddleOCR PP-OCRv6_small), sumar montos (LLM openai-compatible) y exportar a Word (.docx).

## Requisitos
- Node.js 18+
- Chrome (la app usa WASM, SharedArrayBuffer y APIs modernas)

## Comandos

```bash
pnpm install    # instalar dependencias (Vite, TypeScript)
pnpm dev        # servidor de desarrollo + abre Chrome automáticamente
pnpm build      # build de producción → dist/
pnpm preview    # previsualizar el build
pnpm typecheck  # verificación de tipos sin emitir
```

## Spec
Ver [spec.md](./spec.md).
