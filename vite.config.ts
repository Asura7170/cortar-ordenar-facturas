import { defineConfig } from 'vite';

// COOP/COEP: necesarios para WASM con threads (futuro OpenCV/PaddleOCR).
// server.open: abre el navegador en `pnpm dev`. build → dist/.
export default defineConfig({
  server: {
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});
