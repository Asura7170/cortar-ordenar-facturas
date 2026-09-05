/* Cola secuencial de procesamiento — DocAligner recorta, PaddleOCR/LLM extraen (mock aún).
   crop.ts vive en docaligner.ts; la firma procesarCola() ya es la final. */
import { buscarSlot, state } from "../state";
import type { Comprobante } from "../types";
import { aplanar } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear } from "../utils";
import { detectarYRecortar } from "./docaligner";
import { CALIDAD_JPEG } from "./imagen";

const THUMB_MAX = 800; // ≈ 2× la celda real en pantallas 2x

/** Miniatura JPEG; null si no decodificable (se muestra el original). */
export async function generarMiniatura(file: Blob): Promise<string | null> {
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
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/jpeg", CALIDAD_JPEG),
    );
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

/** Blob del comprobante: file en imágenes; en PDF se recupera de su imgUrl (no guarda file). */
async function blobDeItem(sig: Comprobante): Promise<Blob> {
  if (sig.file) return sig.file;
  const res = await fetch(sig.imgUrl);
  return res.blob();
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
      sig.estado = "procesando";
      renderHojas(); // el recorte tarda: que se vea el estado (antes el mock era instantáneo)
      try {
        const original = await blobDeItem(sig);
        const recortada = await detectarYRecortar(original);
        if (recortada !== original) {
          URL.revokeObjectURL(sig.imgUrl);
          if (sig.thumbUrl) URL.revokeObjectURL(sig.thumbUrl);
          sig.imgUrl = URL.createObjectURL(recortada);
          sig.file = recortada;
          sig.thumbUrl = await generarMiniatura(recortada);
        }
      } catch {
        // ponytail: sin recorte se sigue con el original; la cola no se detiene
      }
      if (!buscarSlot(sig.id)) continue; // limpiado durante la espera: no resucita
      // Valores de ejemplo para validar UI/UX (diseño primero, OCR/LLM después).
      sig.textoOcr = sanear(`FACTURA ${sig.nombre}\nFecha: 12/08/2026\nTOTAL: US$ 1,234.56`);
      sig.montoCents = 123456;
      sig.estado = "ok";
      renderHojas();
    }
  } finally {
    state.colaEnProceso = false;
  }
}
