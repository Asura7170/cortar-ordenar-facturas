/* Giro manual por celda (fallback del auto-enderezado): cada pulsación gira
   ±90° el blob definitivo al instante (feedback visual), y la relectura OCR
   corre una sola vez tras QUIETUD_GIRO_MS sin pulsar (doble giro = 2 giros +
   1 OCR). Sin enderezar (que podría devolver el giro) ni re-recortar. Manual
   intacto; no-manual se reabre y el lote lo relee. Nunca lanza. */
import { buscarSlot, obtenerComprobante } from "../state";
import { sanear } from "../utils";
import { asignarMiniatura, generarMiniatura } from "./queue";
import { CALIDAD_JPEG, cargarReal, crearReal } from "./imagen";
import type { DepsOcr } from "./ocr";
import { lienzoGirado } from "./ocr";

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

/** Fase instantánea: gira blob+thumb, pinta y (re)programa el OCR. Nunca lanza. */
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
    const bmp = await cargar(original);
    try {
      const lienzo = lienzoGirado(bmp, grados, crear);
      if (!lienzo) throw new Error("sin contexto 2d");
      const girado = await new Promise<Blob | null>((res) =>
        lienzo.toBlob(res, "image/jpeg", CALIDAD_JPEG),
      );
      if (!girado) throw new Error("sin blob girado");
      // ponytail: commit tras los awaits (igual que la cola: sin dueño no se guarda).
      if (!buscarSlot(id)) return;
      const vieja = item.imgUrl;
      URL.revokeObjectURL(vieja);
      item.imgUrl = URL.createObjectURL(girado);
      item.file = girado;
      const thumb = await generarMiniatura(girado);
      if (thumb && buscarSlot(id)) asignarMiniatura(item, thumb);
      // ponytail: sin thumb el alias al blob revocado (PDF) mira al nuevo.
      else if (item.thumbUrl === vieja && buscarSlot(id)) item.thumbUrl = item.imgUrl;
      renderHojas();
      clearTimeout(relecturas.get(id));
      relecturas.set(
        id,
        setTimeout(() => {
          relecturas.delete(id);
          void releer(id, girado, deps);
        }, QUIETUD_GIRO_MS),
      );
    } finally {
      bmp.close();
    }
  } catch {
    avisar("No se pudo girar la imagen.");
  }
}

/** Fase diferida: un solo OCR tras la quietud + refresco del monto. Nunca lanza. */
async function releer(id: number, blob: Blob, deps?: DepsOcr): Promise<void> {
  const item = obtenerComprobante(id);
  if (!item || !buscarSlot(id)) return;
  try {
    const { renderHojas } = await import("../ui/sheets");
    item.estado = "procesando";
    renderHojas();
    const ocr = await import("./ocr").catch((): null => null);
    if (buscarSlot(id)) item.textoOcr = sanear(ocr ? await ocr.extraerTexto(blob, deps) : "");
    // ponytail: ok ANTES del lote (candidatos exige ok: en procesando se autoexcluía).
    if (buscarSlot(id)) {
      item.estado = "ok";
      renderHojas();
    }
    // No-manual: el total se reabre y el lote lo relee (pelado: silencioso y
    // respeta la cola activa; el drenado lo levanta si aquella trabaja).
    // El lote pinta solo si aplica (el ok + texto ya quedaron pintados arriba).
    if (!item.montoManual && buscarSlot(id)) {
      item.montoCents = null;
      const mod = await import("./extract").catch((): null => null);
      await Promise.resolve(mod?.extraerPendientes()).catch(() => {});
    }
  } catch {
    // ponytail: sin relectura la celda vuelve a ok (el giro ya quedó pintado).
    if (buscarSlot(id)) {
      item.estado = "ok";
      await import("../ui/sheets").then((m) => m.renderHojas()).catch(() => {});
    }
    avisar("No se pudo releer el texto girado.");
  }
}
