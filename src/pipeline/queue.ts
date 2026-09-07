/* Cola secuencial de procesamiento — DocAligner recorta, PP-OCRv6_small extrae
   texto (import dinámico: dict+onnx solo bajan con el primer comprobante).
   Al drenar, el LLM completa los montos en lote (extract.ts); sin TOTAL o sin
   key el monto queda manual. */
import { buscarSlot, state } from "../state";
import type { Comprobante } from "../types";
import { aplanar } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear } from "../utils";
import { detectarYRecortar, obtenerSesion } from "./docaligner";
import { CALIDAD_JPEG } from "./imagen";
import type { Enderezado } from "./ocr";
import { diagVacio } from "./ocr";

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

/**
 * Fija la miniatura final sin revocar el imgUrl: en PDF ambos campos aliasan
 * la misma URL y revocar el thumb mataba la vista previa. Puro salvo el revoke.
 */
export function asignarMiniatura(sig: Comprobante, thumbNueva: string): void {
  if (sig.thumbUrl && sig.thumbUrl !== sig.imgUrl) URL.revokeObjectURL(sig.thumbUrl);
  sig.thumbUrl = thumbNueva;
}

/**
 * Precalienta los modelos en serie ante intención de subida (una sola vez).
 * Nunca en paralelo ni en el arranque: las sesiones compiten por el mismo
 * contexto GPU y la precarga concurrente en idle colgó la pestaña. Si falla,
 * el uso real reintenta (los singletons resetean en fallo).
 */
let precalentado = false;
export function precalentarModelos(): void {
  if (precalentado) return;
  precalentado = true;
  const ceder = (): Promise<void> =>
    new Promise((res) => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => res());
      else setTimeout(() => res(), 0);
    });
  void (async (): Promise<void> => {
    try {
      await obtenerSesion();
      await ceder(); // que los clics respiren entre compilaciones
      const ocr = await import("./ocr").catch((): null => null);
      await ocr?.obtenerNucleo();
    } catch {
      // el uso real reintenta; el warm-up es best-effort
    }
  })();
}

export async function procesarCola(): Promise<void> {
  if (state.colaEnProceso) return;
  state.colaEnProceso = true;
  try {
    // ponytail: drenado por pendiente, no snapshot; token generación si el MOCK se vuelve concurrente.
    // Fase 1: el "procesando" se pinta por ítem (feedback), el "ok" una vez al drenar.
    for (;;) {
      let tocada = false;
      for (;;) {
        // Relee el estado actual: Limpiar puede reemplazar state.hojas durante el await.
        const sig = aplanar().find((c) => c.estado === "pendiente");
        if (!sig) break;
        sig.estado = "procesando";
        renderHojas(); // el recorte tarda: que se vea el estado (antes el mock era instantáneo)
        // L0: tiempos por etapa (medir antes de optimizar).
        const t0 = performance.now();
        const ms = { recorte: 0, minis: 0, enderezar: 0, extraer: 0, diag: "" };
        try {
          const t = performance.now();
          const original = await blobDeItem(sig);
          const recortada = await detectarYRecortar(original);
          ms.recorte = performance.now() - t;
          if (recortada !== original) {
            // ponytail: commit tras el await — si se limpió durante la espera, se
            // revocan las nuevas y el guard de abajo evita resucitar.
            // L1: la miniatura se genera una sola vez al final (no aquí).
            const imgNueva = URL.createObjectURL(recortada);
            if (!buscarSlot(sig.id)) {
              URL.revokeObjectURL(imgNueva);
            } else {
              URL.revokeObjectURL(sig.imgUrl);
              sig.imgUrl = imgNueva;
              sig.file = recortada;
            }
          }
        } catch {
          // ponytail: sin recorte se sigue con el original; la cola no se detiene
        }
        if (!buscarSlot(sig.id)) continue; // limpiado durante la espera: no resucita
        // ponytail: un solo import dinámico + blob reutilizado (en PDF evita refetch).
        const ocr = await import("./ocr").catch((): null => null);
        // L1: el blob ya está en memoria (recorte) o en sig.file (foto); sin file
        // se refetchea (PDF). Un solo decode por comprobante.
        let blob: Blob | null = sig.file ?? null;
        if (!blob) {
          try {
            blob = await blobDeItem(sig);
          } catch {
            blob = null;
          }
        }
        // Endereza por confianza del rec (det solo recorta líneas, no vota).
        let end: Enderezado | null = null;
        try {
          if (ocr && blob) {
            const t = performance.now();
            end = await ocr.enderezar(blob);
            ms.enderezar = performance.now() - t;
            if (end.grados !== 0 && buscarSlot(sig.id)) {
              // ponytail: commit tras el await (igual que el recorte: sin dueño no se guarda).
              const imgNueva = URL.createObjectURL(end.blob);
              if (!buscarSlot(sig.id)) {
                URL.revokeObjectURL(imgNueva);
              } else {
                URL.revokeObjectURL(sig.imgUrl);
                sig.imgUrl = imgNueva;
                sig.file = end.blob;
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
          // L1: reuse evita repetir el det del giro ganador (end trae cajas/base).
          const diag = diagVacio();
          sig.textoOcr =
            ocr && blob
              ? sanear(await ocr.extraerTexto(blob, undefined, end ?? undefined, diag))
              : "";
          ms.extraer = performance.now() - t;
          // P1: cajas, forma del lote, fallback y nº de runs del rec.
          ms.diag =
            `cajas=${diag.cajas} batch=[${diag.lote},${diag.anchoMax}] ` +
            `fallback=${diag.fallback ? "sí" : "no"} recRuns=${diag.recRuns}`;
        } catch {
          sig.textoOcr = "";
        }
        // L1: una sola miniatura al final, sobre la imagen definitiva.
        if (blob) {
          const tm = performance.now();
          const thumbNueva = await generarMiniatura(blob);
          ms.minis += performance.now() - tm;
          if (thumbNueva) {
            if (!buscarSlot(sig.id)) URL.revokeObjectURL(thumbNueva);
            else asignarMiniatura(sig, thumbNueva);
          }
        }
        if (!buscarSlot(sig.id)) continue; // limpiado durante la miniatura: no resucita
        sig.montoCents = null;
        sig.estado = "ok";
        const entero = (v: number): number => Math.round(v);
        console.info(
          `OCR ms ${sig.nombre}: recorte=${entero(ms.recorte)} minis=${entero(ms.minis)} ` +
            `enderezar=${entero(ms.enderezar)} extraer=${entero(ms.extraer)} ` +
            `${ms.diag} total=${entero(performance.now() - t0)}`,
        );
        tocada = true;
      }
      if (!tocada) break;
      // Auto IA en lote (1 llamada): best-effort, nunca tumba la cola.
      const { extraerPendientes } = await import("./extract");
      await Promise.resolve(extraerPendientes({ desdeCola: true })).catch(() => {});
      renderHojas(); // estado final del lote (la IA ya pintó si aplicó montos)
      // Entrados durante la IA: el loop los drena sin soltar el flag (sin huérfanos).
    }
  } finally {
    state.colaEnProceso = false;
  }
}
