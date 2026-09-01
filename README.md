# Cortar y Ordenar Facturas

App frontend-only para recortar comprobantes/facturas (OpenCV.js), extraer texto (PaddleOCR PP-OCRv6_small), sumar montos (LLM openai-compatible) y exportar a Word (.docx).

## Requisitos
- Node.js 18+
- Chrome (la app usa WASM, SharedArrayBuffer y APIs modernas)

## Comandos

```bash
npm install        # instalar dependencias (Vite, TypeScript, docx, etc.)
npm run dev --open # servidor de desarrollo + abre Chrome automáticamente
npm run build      # build de producción → dist/
```

## Spec
Ver [spec.md](./spec.md).
