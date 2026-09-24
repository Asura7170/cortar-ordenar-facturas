/* Cola secuencial de procesamiento — DocAligner recorta, PP-OCRv6_small extrae
   texto (import dinámico: dict+onnx solo bajan con el primer comprobante).
   Cada ítem extrae su monto 1×1 al completar (extract.ts, pintado progresivo);
   al drenar, el lote cubre lo pendiente; sin TOTAL o sin key el monto queda manual. */
import { buscarSlot, state } from "../state";
import type { Comprobante } from "../types";
import { aplanar } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear } from "../utils";
import { detectarYRecortar, obtenerSesion } from "./docaligner";
import { extraerUnMonto } from "./extract";
import { extraerRapidoCents } from "./jev";
import type { Enderezado } from "./ocr";
import { diagVacio } from "./ocr";
/** Blob del comprobante: file en imágenes; en PDF se recupera de su imgUrl (no guarda file). */
async function blobDeItem(sig: Comprobante): Promise<Blob> {
  if (sig.file) return sig.file;
  const res = await fetch(sig.imgUrl);
  return res.blob();
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
    // Fase 1: el "procesando" y el "ok" (imagen) se pintan por ítem; el monto cae progresivo.
    // JEV vuela desacoplado (nube): el OCR del siguiente no espera al monto del actual.
    const vuelos: Promise<boolean>[] = [];
    for (;;) {
      let tocada = false;
      for (;;) {
        // Relee el estado actual: Limpiar puede reemplazar state.hojas durante el await.
        const sig = aplanar().find((c) => c.estado === "pendiente");
        if (!sig) break;
        try {
          sig.estado = "procesando";
          try {
            renderHojas(); // el recorte tarda: que se vea el estado (antes el mock era instantáneo)
          } catch {
            /* el render nunca aborta la cola */
          }
          // L0: tiempos por etapa (medir antes de optimizar).
          const t0 = performance.now();
          const ms = { recorte: 0, enderezar: 0, extraer: 0, diag: "" };
          try {
            const t = performance.now();
            const original = await blobDeItem(sig);
            const recortada = await detectarYRecortar(original);
            ms.recorte = performance.now() - t;
            if (recortada !== original) {
              // ponytail: commit tras el await — si se limpió durante la espera, se
              // revocan las nuevas y el guard de abajo evita resucitar.
              const imgNueva = URL.createObjectURL(recortada);
              if (!buscarSlot(sig.id)) {
                URL.revokeObjectURL(imgNueva);
              } else {
                URL.revokeObjectURL(sig.imgUrl);
                sig.imgUrl = imgNueva;
                // ponytail: el intake pre-warp se conserva para el recorte manual
                // (recuperar lo cortado de más); sin object URL, el GC lo recoge.
                sig.previoDocAligner = original;
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
                  // ponytail: el previo acompaña a la rotación (ver giro manual).
                  // Sin re-import (ocr ya está cargado arriba).
                  const previoGirado =
                    sig.previoDocAligner && ocr
                      ? await ocr.girarBlob(sig.previoDocAligner, end.grados)
                      : null;
                  // ponytail: re-chequeo tras el await (limpiado en la ventana:
                  // se revoca lo nuevo, no se muta el sig huérfano).
                  if (!buscarSlot(sig.id)) {
                    URL.revokeObjectURL(imgNueva);
                  } else {
                    if (previoGirado) sig.previoDocAligner = previoGirado;
                    // ponytail: si falla, se conserva el viejo (un fallo transitorio
                    // no debe destruir la fuente de recuperación del sobre-recorte).
                    sig.file = end.blob;
                    blob = end.blob;
                  }
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
          // L1: sin miniatura (la celda pinta el full-res con lazy).
          if (!buscarSlot(sig.id)) continue; // limpiado durante el OCR: no resucita
          sig.montoCents = null;
          sig.estado = "ok";
          // ponytail: fast-path offline — 1 distinto se fija sin red; el resto vuela a JEV.
          const rapido = extraerRapidoCents(sig.textoOcr ?? "");
          if (rapido !== null) sig.montoCents = rapido;
          try {
            renderHojas(); // imagen visible al instante, sin esperar al JEV (~1s/factura)
          } catch {
            /* el render nunca aborta la cola */
          }
          // JEV desacoplado: vuela en paralelo al OCR del siguiente; el monto cae progresivo.
          // Best-effort (nunca lanza): lo no resuelto cae a la red del drenado.
          // ponytail: Promise.resolve envuelve el mock de tests tras restoreAllMocks (devuelve
          // undefined sin impl); en prod extraerUnMonto siempre es Promise<boolean>.
          if (rapido === null)
            vuelos.push(Promise.resolve(extraerUnMonto(sig.id)).catch((): boolean => false));
          const entero = (v: number): number => Math.round(v);
          // ponytail: telemetría local en dev (en prod es ruido + nombre de usuario en consola)
          if (import.meta.env.DEV)
            console.info(
              `OCR ms ${sig.nombre}: recorte=${entero(ms.recorte)} ` +
                `enderezar=${entero(ms.enderezar)} extraer=${entero(ms.extraer)} ` +
                `${ms.diag} total=${entero(performance.now() - t0)}`,
            );
        } catch {
          // ponytail: ítem envenenado → celda de error visible; los hermanos
          // siguen (antes un throw dejaba a todos "cargando" para siempre).
          if (buscarSlot(sig.id)) {
            sig.textoOcr = "";
            sig.montoCents = null;
            sig.estado = "error";
          }
        }
        tocada = true;
      }
      if (!tocada) break;
      // Espera a los JEV en vuelo antes de la red (evita doble fetch); la red cubre lo pendiente.
      await Promise.allSettled(vuelos);
      vuelos.length = 0;
      // Red del drenado: lo que el 1×1 no resolvió va en lote (best-effort, nunca tumba la cola).
      const mod = await import("./extract").catch((): null => null);
      await Promise.resolve(mod?.extraerPendientes({ desdeCola: true })).catch(() => {});
      try {
        renderHojas(); // estado final del lote (la IA ya pintó si aplicó montos)
      } catch {
        /* el render nunca aborta la cola */
      }
      // Entrados durante la IA: el loop los drena sin soltar el flag (sin huérfanos).
    }
  } finally {
    state.colaEnProceso = false;
  }
}
