/* Cola secuencial de procesamiento — MOCK de UI.
   El pipeline real (OpenCV crop → PaddleOCR → LLM extract) vivirá en
   crop.ts/ocr.ts/pdf.ts/extract.ts; la firma procesarCola() ya es la final. */
import { state } from '../state';
import { itemsDe } from '../ui/monto';
import { renderHojas } from '../ui/sheets';
import { sanear, sleep } from '../utils';

const THUMB_MAX = 800; // ≈ 2× la celda real en pantallas 2x

/** Miniatura WebP; null si es PDF o no decodificable (se muestra el original). */
export async function generarMiniatura(file: File): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const escala = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    let red = bmp;
    if (escala < 1) {
      red = await createImageBitmap(bmp, {
        resizeWidth: Math.max(1, Math.round(bmp.width * escala)),
        resizeHeight: Math.max(1, Math.round(bmp.height * escala)),
        resizeQuality: 'high',
      });
      bmp.close();
    }
    const canvas = document.createElement('canvas');
    canvas.width = red.width;
    canvas.height = red.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { red.close(); return null; }
    ctx.drawImage(red, 0, 0);
    red.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', 0.82));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export async function procesarCola(): Promise<void> {
  if (state.colaEnProceso) return;
  state.colaEnProceso = true;
  for (const hoja of state.hojas) {
    for (const c of itemsDe(hoja)) {
      if (c.estado === 'pendiente') {
        // Sin render intermedio: el esqueleto ya comunica la espera (2N+1 → N+1 renders).
        c.estado = 'procesando';
        // Placeholder: aquí irá el pipeline OpenCV→OCR→LLM.
        await sleep(900);
        // Valores de ejemplo para validar UI/UX (diseño primero, pipeline después).
        c.textoOcr = sanear(`FACTURA ${c.nombre}\nFecha: 12/08/2026\nTOTAL: US$ 1,234.56`);
        c.montoCents = 123456;
        c.estado = 'ok';
        renderHojas();
      }
    }
  }
  state.colaEnProceso = false;
}
