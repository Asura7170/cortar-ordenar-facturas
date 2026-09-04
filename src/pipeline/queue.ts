/* Cola secuencial de procesamiento — MOCK de UI.
   El pipeline real (OpenCV crop → PaddleOCR → LLM extract) vivirá en
   crop.ts/ocr.ts/pdf.ts/extract.ts; la firma procesarCola() ya es la final. */
import { buscarSlot, state } from "../state";
import { aplanar } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear, sleep } from "../utils";
import { esPdf, generarMiniaturaPdf } from "./pdf";

const THUMB_MAX = 800; // ≈ 2× la celda real en pantallas 2x

/** Miniatura WebP; null si no decodificable (se muestra el original). */
export async function generarMiniatura(file: File): Promise<string | null> {
  if (esPdf(file)) return generarMiniaturaPdf(file);
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const escala = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    let red = bmp;
    if (escala < 1) {
      red = await createImageBitmap(bmp, {
        resizeWidth: Math.max(1, Math.round(bmp.width * escala)),
        resizeHeight: Math.max(1, Math.round(bmp.height * escala)),
        resizeQuality: "high",
      });
      bmp.close();
    }
    const canvas = document.createElement("canvas");
    canvas.width = red.width;
    canvas.height = red.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      red.close();
      return null;
    }
    ctx.drawImage(red, 0, 0);
    red.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.82));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export async function procesarCola(): Promise<void> {
  if (state.colaEnProceso) return;
  state.colaEnProceso = true;
  try {
    // ponytail: drenado por pendiente, no snapshot; token generación si el MOCK se vuelve concurrente.
    for (;;) {
      // Relee el estado actual: Limpiar puede reemplazar state.hojas durante el await.
      const sig = aplanar().find((c) => c.estado === "pendiente");
      if (!sig) break;
      // Sin render intermedio: el esqueleto ya comunica la espera (2N+1 → N+1 renders).
      sig.estado = "procesando";
      // Placeholder: aquí irá el pipeline OpenCV→OCR→LLM.
      await sleep(900);
      if (!buscarSlot(sig.id)) continue; // limpiado durante la espera: no resucita
      // Valores de ejemplo para validar UI/UX (diseño primero, pipeline después).
      sig.textoOcr = sanear(`FACTURA ${sig.nombre}\nFecha: 12/08/2026\nTOTAL: US$ 1,234.56`);
      sig.montoCents = 123456;
      sig.estado = "ok";
      renderHojas();
    }
  } finally {
    state.colaEnProceso = false;
  }
}
