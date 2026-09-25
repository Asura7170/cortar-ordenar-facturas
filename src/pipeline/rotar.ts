/* Giro manual por celda (fallback del auto-enderezado): cada pulsación gira
   ±90° el blob definitivo al instante (feedback visual), y la relectura OCR
   corre una sola vez tras QUIETUD_GIRO_MS sin pulsar (doble giro = 2 giros +
   1 OCR). Sin enderezar (que podría devolver el giro) ni re-recortar. Manual
   intacto; no-manual se reabre y el lote lo relee. Nunca lanza. */
import { buscarSlot, obtenerComprobante, state } from "../state";
import { sanear } from "../utils";
import { CALIDAD_WEBP, cargarReal, crearReal } from "./imagen";
import type { DepsOcr } from "./ocr";
import { girarBlob, lienzoGirado } from "./ocr";

export type GiroManual = 90 | 270;

/** Quietud sin pulsar antes de releer (doble giro para 180° sin doble OCR). */
export const QUIETUD_GIRO_MS = 1500;

/** Relecturas OCR pendientes por item (debounce multi-giro, transitorio). */
const relecturas = new Map<number, ReturnType<typeof setTimeout>>();
/** Cadena de giros por item: cada pulsación parte del blob ya commiteado. */
const girosEnCurso = new Map<number, Promise<void>>();

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

/** Gira al instante y programa la relectura diferida. No-op si no está ok. */
export async function girarYReleer(id: number, grados: GiroManual, deps?: DepsOcr): Promise<void> {
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  // ponytail: cadena tolerante (un turno fallido no envenena los siguientes).
  const anterior = girosEnCurso.get(id) ?? Promise.resolve();
  const turno = anterior.catch(() => {}).then(() => girar(id, grados, deps));
  girosEnCurso.set(id, turno);
  try {
    await turno;
  } finally {
    if (girosEnCurso.get(id) === turno) girosEnCurso.delete(id);
  }
}

/** Fase instantánea: gira el blob, pinta y (re)programa el OCR. Nunca lanza. */
async function girar(id: number, grados: GiroManual, deps?: DepsOcr): Promise<void> {
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  // ponytail: render dinámico dentro del try (sheets importa este módulo:
  // estático sería ciclo; fuera del try un chunk fallido era rejection muda).
  try {
    const { renderHojas } = await import("../ui/sheets");
    const cargar = deps?.cargar ?? cargarReal;
    const crear = deps?.crear ?? crearReal;
    const original = item.file ?? (await (await fetch(item.imgUrl)).blob());
    const bmp = await cargar(original, { imageOrientation: "from-image" });
    try {
      const lienzo = lienzoGirado(bmp, grados, crear);
      if (!lienzo) throw new Error("sin contexto 2d");
      const girado = await new Promise<Blob | null>((res) =>
        lienzo.toBlob(res, "image/webp", CALIDAD_WEBP),
      );
      if (!girado) throw new Error("sin blob girado");
      // ponytail: el previo acompaña al giro (con orientación rancia el próximo
      // recorte manual ensancharía sobre píxeles viejos: se aborta, no se mezcla).
      const giradoPrevio = item.previoDocAligner
        ? await girarBlob(item.previoDocAligner, grados, cargar, crear)
        : null;
      if (item.previoDocAligner && !giradoPrevio) throw new Error("sin previo girado");
      const imgNueva = URL.createObjectURL(girado);
      // ponytail: commit atómico tras los awaits (giro vs recorte en vuelo:
      // mutar partido mezclaba imgUrl de uno con file del otro).
      if (!buscarSlot(id)) {
        URL.revokeObjectURL(imgNueva);
        return;
      }
      URL.revokeObjectURL(item.imgUrl);
      item.imgUrl = imgNueva;
      item.file = girado;
      if (giradoPrevio) item.previoDocAligner = giradoPrevio;
      renderHojas();
      clearTimeout(relecturas.get(id));
      relecturas.set(
        id,
        setTimeout(() => {
          relecturas.delete(id);
          // ponytail: si un recorte commitió después, el giro es rancio: no relee.
          if (obtenerComprobante(id)?.file !== girado) return;
          void releerTrasEdicion(id, girado, deps);
        }, QUIETUD_GIRO_MS),
      );
    } finally {
      bmp.close();
    }
  } catch {
    avisar("No se pudo girar la imagen.");
  }
}

/** Cancela la relectura diferida de un giro (el recorte commitea su propia
    relectura inmediata: sin esto el timer rancio la pisaba después). */
export function cancelarRelecturaProgramada(id: number): void {
  clearTimeout(relecturas.get(id));
  relecturas.delete(id);
}

/** Cadena de relecturas por item: el giro con debounce y el recorte manual se
    solaparían sobre el mismo id (texto/monto cruzados). Igual que girosEnCurso. */
const relecturasEnCurso = new Map<number, Promise<void>>();

/** Relectura serializada por item (el último editor corre último: su texto gana). */
export async function releerTrasEdicion(id: number, blob: Blob, deps?: DepsOcr): Promise<void> {
  const anterior = relecturasEnCurso.get(id) ?? Promise.resolve();
  const turno = anterior.catch(() => {}).then(() => releer(id, blob, deps));
  relecturasEnCurso.set(id, turno);
  try {
    await turno;
  } finally {
    if (relecturasEnCurso.get(id) === turno) relecturasEnCurso.delete(id);
  }
}

/** Espera a que la cola suelte el flag (tope 120s: el lote nunca queda huérfano). */
async function esperarDrenaje(): Promise<void> {
  for (let i = 0; i < 480 && state.colaEnProceso; i++) {
    await new Promise((res) => setTimeout(res, 250));
  }
}

/** Fase diferida: un solo OCR tras la quietud + refresco del monto. Nunca lanza.
 * (Trabajadora privada: entrar por releerTrasEdicion, que serializa por item.
 * También la usa el recorte manual, que invalida texto y monto igual.) */
async function releer(id: number, blob: Blob, deps?: DepsOcr): Promise<void> {
  const item = obtenerComprobante(id);
  if (!item || !buscarSlot(id)) return;
  try {
    const { renderHojas } = await import("../ui/sheets");
    item.estado = "procesando";
    renderHojas();
    // ponytail: las sesiones ORT son singletons sin mutex interno (un run()
    // concurrente de la cola + este cuelga a ambos): el OCR espera su turno.
    if (state.colaEnProceso) await esperarDrenaje();
    const ocr = await import("./ocr").catch((): null => null);
    if (buscarSlot(id)) item.textoOcr = sanear(ocr ? await ocr.extraerTexto(blob, deps) : "");
    // ponytail: ok ANTES del lote (candidatos exige ok: en procesando se autoexcluía).
    if (buscarSlot(id)) {
      item.estado = "ok";
      renderHojas();
    }
    // No-manual: el total se reabre y el lote lo relee. Si la cola trabaja se
    // espera a que drene: el batch excluye al "procesando" y sin espera el
    // monto quedaba huérfano hasta el próximo disparo.
    // El lote pinta solo si aplica (el ok + texto ya quedaron pintados arriba).
    if (!item.montoManual && buscarSlot(id)) {
      item.montoCents = null;
      renderHojas(); // el lote puede ser no-op: sin esto el badge viejo miente
      const mod = await import("./extract").catch((): null => null);
      if (state.colaEnProceso) await esperarDrenaje();
      await Promise.resolve(mod?.extraerPendientes()).catch(() => {});
    }
  } catch {
    // ponytail: sin relectura no vale el texto viejo (es de otra orientación).
    if (buscarSlot(id)) {
      item.textoOcr = "";
      if (!item.montoManual) item.montoCents = null;
      item.estado = "ok";
      await import("../ui/sheets").then((m) => m.renderHojas()).catch(() => {});
    }
    avisar("No se pudo releer el texto girado.");
  }
}
