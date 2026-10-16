/* Cola secuencial de procesamiento — DocAligner recorta, PP-OCRv6_small extrae
   texto (import dinámico: dict+onnx solo bajan con el primer comprobante).
   Cada ítem fija su monto por regex al completar (fast-path, pintado progresivo);
   al drenar, extraerPendientes re-chequea lo pendiente; sin total legible queda manual. */
import { buscarSlot, state } from "../state";
import type { Comprobante } from "../types";
import { aplanar } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear } from "../utils";
import { detectarYRecortar, falloIa, obtenerSesion } from "./docaligner";
import {
  aplicarTotales,
  extraerPendientes,
  extraerRapidoCents,
  limpiarTextoCompleto,
} from "./extract";
import type { Enderezado, Giro } from "./ocr";
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
      // el uso real reintenta; el warm-up es best-effort (el intake real avisa)
    }
  })();
}

/** Tipo del módulo ocr que llega por el import dinámico (nulo si no resolvió). */
type ModuloOcr = typeof import("./ocr");

/** Blob vigente para el OCR: file del commit (recorte/giro) o refetch en PDF. */
async function blobActual(sig: Comprobante): Promise<Blob | null> {
  // ponytail: L1 — el blob ya está en memoria tras el recorte (file) o se refetchea (PDF, sin file guardado). Un solo decode por comprobante.
  if (sig.file) return sig.file;
  try {
    return await blobDeItem(sig);
  } catch {
    return null;
  }
}

/** Recorta con DocAligner y commitea la imagen si cambió. */
async function faseRecorte(sig: Comprobante): Promise<void> {
  try {
    const original = await blobDeItem(sig);
    const recortada = await detectarYRecortar(original);
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
}

/** Gira el intake previo al mismo grados (el rechazo lo toma el catch de la fase). */
function girarPrevio(
  sig: Comprobante,
  ocr: NonNullable<ModuloOcr>,
  grados: Giro,
): Promise<Blob | null> {
  // ponytail: el previo acompaña a la rotación (ver giro manual); si falla se
  // conserva el viejo (un fallo transitorio no destruye la recuperación del
  // sobre-recorte) y la URL rotada ya commiteada permanece.
  return sig.previoDocAligner ? ocr.girarBlob(sig.previoDocAligner, grados) : Promise.resolve(null);
}

/** Endereza por confianza del rec y commitea el giro; devuelve el end para el reuse OCR. */
async function faseEnderezar(
  sig: Comprobante,
  blob: Blob | null,
  ocr: ModuloOcr | null,
): Promise<Enderezado | null> {
  let end: Enderezado | null = null;
  try {
    if (ocr && blob) {
      end = await ocr.enderezar(blob);
      if (end.grados !== 0 && buscarSlot(sig.id)) {
        // ponytail: commit tras el await (igual que el recorte: sin dueño no se guarda).
        const imgNueva = URL.createObjectURL(end.blob);
        if (!buscarSlot(sig.id)) {
          URL.revokeObjectURL(imgNueva);
        } else {
          URL.revokeObjectURL(sig.imgUrl);
          sig.imgUrl = imgNueva;
          const previoGirado = await girarPrevio(sig, ocr, end.grados);
          // ponytail: re-chequeo tras el await (limpiado en la ventana:
          // se revoca lo nuevo, no se muta el sig huérfano).
          if (!buscarSlot(sig.id)) {
            URL.revokeObjectURL(imgNueva);
          } else {
            if (previoGirado) sig.previoDocAligner = previoGirado;
            // ponytail: si el giro del previo falló, se conserva el viejo (fallo
            // transitorio no destruye la fuente de recuperación del sobre-recorte).
            sig.file = end.blob;
          }
        }
      }
    }
  } catch {
    // ponytail: sin enderezar se sigue con la imagen tal cual
  }
  return end;
}

/** OCR real (perezoso): texto saneado en el ítem. */
async function faseOcr(
  sig: Comprobante,
  blob: Blob | null,
  ocr: ModuloOcr | null,
  end: Enderezado | null,
): Promise<void> {
  try {
    // L1: reuse evita repetir el det del giro ganador (end trae cajas/base).
    sig.textoOcr =
      ocr && blob ? sanear(await ocr.extraerTexto(blob, undefined, end ?? undefined)) : "";
  } catch {
    sig.textoOcr = "";
  }
}

/** Cierra el ítem: ok + monto fast-path offline + render. */
function completarItem(sig: Comprobante): void {
  // L1: sin miniatura (la celda pinta el full-res con lazy).
  sig.montoCents = null;
  sig.estado = "ok";
  // ponytail: fast-path offline — 1 distinto se fija sin red (vía aplicarTotales:
  // borrador en curso, manual y texto rancio ganan); el resto queda manual.
  // (textoOcr ya asignado por faseOcr en ambas salidas.)
  const textoLimpio = limpiarTextoCompleto(sig.textoOcr as string);
  const rapido = extraerRapidoCents(textoLimpio);
  if (rapido !== null)
    aplicarTotales([{ idx: 1, id: sig.id, texto: textoLimpio }], new Map([[1, rapido]]));
  try {
    renderHojas(); // imagen visible al instante
  } catch {
    /* el render nunca aborta la cola */
  }
}

/** Procesa un pendiente completo. False si lo limpiaron durante los awaits: no se cuenta tocada. */
async function procesarItem(sig: Comprobante): Promise<boolean> {
  sig.estado = "procesando";
  try {
    renderHojas(); // el recorte tarda: que se vea el estado (antes el mock era instantáneo)
  } catch {
    /* el render nunca aborta la cola */
  }
  await faseRecorte(sig);
  if (!buscarSlot(sig.id)) return false; // limpiado durante la espera: no resucita
  // ponytail: un solo import dinámico + blob reutilizado (en PDF evita refetch).
  const ocr = await import("./ocr").catch((e: unknown): null => {
    falloIa(e, "OCR");
    return null;
  });
  const blob: Blob | null = await blobActual(sig);
  // Endereza por confianza del rec (det solo recorta líneas, no vota).
  const end = await faseEnderezar(sig, blob, ocr);
  if (!buscarSlot(sig.id)) return false; // limpiado durante el enderezado: no resucita
  await faseOcr(sig, sig.file ?? blob, ocr, end);
  if (!buscarSlot(sig.id)) return false; // limpiado durante el OCR: no resucita
  completarItem(sig);
  return true;
}

/** Drena pendientes en orden de scan. True si tocó al menos un ítem. */
async function drenarCola(): Promise<boolean> {
  let tocada = false;
  for (;;) {
    // Relee el estado actual: Limpiar puede reemplazar state.hojas durante el await.
    const sig = aplanar().find((c) => c.estado === "pendiente");
    if (!sig) break;
    try {
      if (await procesarItem(sig)) tocada = true;
    } catch {
      // ponytail: ítem envenenado → celda de error visible; los hermanos
      // siguen (antes un throw dejaba a todos "cargando" para siempre).
      if (buscarSlot(sig.id)) {
        sig.textoOcr = "";
        sig.montoCents = null;
        sig.estado = "error";
      }
      tocada = true;
    }
  }
  return tocada;
}

export async function procesarCola(): Promise<void> {
  if (state.colaEnProceso) return;
  state.colaEnProceso = true;
  try {
    // ponytail: drenado por pendiente, no snapshot; token generación si el MOCK se vuelve concurrente.
    // Fase 1: el "procesando" y el "ok" (imagen) se pintan por ítem; el monto cae por regex.
    for (;;) {
      if (!(await drenarCola())) break;
      // Re-chequeo del drenado: lo que el fast-path dejó (texto nuevo con giro,
      // intake tardío) va por extraerPendientes (síncrono, nunca tumba la cola).
      try {
        extraerPendientes({ desdeCola: true });
      } catch {
        /* el re-chequeo nunca tumba la cola */
      }
      try {
        renderHojas(); // estado final (extraerPendientes ya pintó si aplicó montos)
      } catch {
        /* el render nunca aborta la cola */
      }
      // Entrados durante el OCR/render del ítem: el loop los drena sin soltar el flag (sin huérfanos).
    }
  } finally {
    state.colaEnProceso = false;
  }
}
