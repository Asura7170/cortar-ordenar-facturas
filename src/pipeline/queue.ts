/* Cola secuencial de procesamiento — DocAligner recorta, PP-OCRv6_small extrae
   texto (import dinámico: dict+onnx solo bajan con el primer comprobante).
   El monto queda manual hasta el LLM (extract.ts futuro). */
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
      // L0: tiempos por etapa (medir antes de optimizar).
      const t0 = performance.now();
      const ms = { recorte: 0, minis: 0, enderezar: 0, extraer: 0 };
      try {
        const t = performance.now();
        const original = await blobDeItem(sig);
        const recortada = await detectarYRecortar(original);
        ms.recorte = performance.now() - t;
        if (recortada !== original) {
          // ponytail: commit tras el await — si se limpió durante la espera, se
          // revocan las nuevas y el guard de abajo evita resucitar.
          const imgNueva = URL.createObjectURL(recortada);
          const tm = performance.now();
          const thumbNueva = await generarMiniatura(recortada);
          ms.minis += performance.now() - tm;
          if (!buscarSlot(sig.id)) {
            URL.revokeObjectURL(imgNueva);
            if (thumbNueva) URL.revokeObjectURL(thumbNueva);
          } else {
            URL.revokeObjectURL(sig.imgUrl);
            if (sig.thumbUrl) URL.revokeObjectURL(sig.thumbUrl);
            sig.imgUrl = imgNueva;
            sig.file = recortada;
            sig.thumbUrl = thumbNueva;
          }
        }
      } catch {
        // ponytail: sin recorte se sigue con el original; la cola no se detiene
      }
      if (!buscarSlot(sig.id)) continue; // limpiado durante la espera: no resucita
      // ponytail: un solo import dinámico + blob reutilizado (en PDF evita refetch).
      const ocr = await import("./ocr").catch((): null => null);
      let blob: Blob | null = null;
      try {
        blob = await blobDeItem(sig);
      } catch {
        blob = null;
      }
      // Endereza por confianza del rec (det solo recorta líneas, no vota).
      try {
        if (ocr && blob) {
          const t = performance.now();
          const end = await ocr.enderezar(blob);
          ms.enderezar = performance.now() - t;
          if (end.grados !== 0 && buscarSlot(sig.id)) {
            console.info(`OCR: giro ${end.grados}° en ${sig.nombre}`);
            // ponytail: commit tras el await (igual que el recorte: sin dueño no se guarda).
            const imgNueva = URL.createObjectURL(end.blob);
            const tm = performance.now();
            const thumbNueva = await generarMiniatura(end.blob);
            ms.minis += performance.now() - tm;
            if (!buscarSlot(sig.id)) {
              URL.revokeObjectURL(imgNueva);
              if (thumbNueva) URL.revokeObjectURL(thumbNueva);
            } else {
              URL.revokeObjectURL(sig.imgUrl);
              if (sig.thumbUrl) URL.revokeObjectURL(sig.thumbUrl);
              sig.imgUrl = imgNueva;
              sig.file = end.blob;
              sig.thumbUrl = thumbNueva;
              blob = end.blob;
            }
          }
        }
      } catch {
        // ponytail: sin enderezar se sigue con la imagen tal cual
      }
      if (!buscarSlot(sig.id)) continue; // limpiado durante el enderezado: no resucita
      // OCR real (PP-OCRv6_small, perezoso); sin texto o con fallo el monto queda manual.
      try {
        const t = performance.now();
        sig.textoOcr = ocr && blob ? sanear(await ocr.extraerTexto(blob)) : "";
        ms.extraer = performance.now() - t;
      } catch {
        sig.textoOcr = "";
      }
      sig.montoCents = null;
      sig.estado = "ok";
      const entero = (v: number): number => Math.round(v);
      console.info(
        `OCR ms ${sig.nombre}: recorte=${entero(ms.recorte)} minis=${entero(ms.minis)} ` +
          `enderezar=${entero(ms.enderezar)} extraer=${entero(ms.extraer)} ` +
          `total=${entero(performance.now() - t0)}`,
      );
      renderHojas();
    }
  } finally {
    state.colaEnProceso = false;
  }
}
