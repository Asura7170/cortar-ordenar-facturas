/* Giro manual por celda (fallback del auto-enderezado): cada pulsación gira
   ±90° el blob definitivo al instante (feedback visual), y la relectura OCR
   corre una sola vez tras QUIETUD_GIRO_MS sin pulsar (doble giro = 2 giros +
   1 OCR). Sin enderezar (que podría devolver el giro) ni re-recortar. Manual
   intacto; no-manual se reabre y el lote lo relee. Nunca lanza. */
import { buscarSlot, obtenerComprobante, state } from "../state";
import type { Comprobante } from "../types";
import { avisarError, sanear } from "../utils";
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

// ponytail: delega en el helper compartido — misma firma, así los 2 llamados
// quedan intactos y el error sale en el toast rojo de #aviso.
function avisar(texto: string): void {
  avisarError(texto);
}

/** Cargador/factory para el giro o el real (mejoras de deps fuera del cuerpo). */
function cargarVigente(deps: DepsOcr | undefined): typeof cargarReal {
  return deps?.cargar ?? cargarReal;
}

/** Factory para el giro o la real (mejoras de deps fuera del cuerpo). */
function crearVigente(deps: DepsOcr | undefined): typeof crearReal {
  return deps?.crear ?? crearReal;
}

/** El blob definido por el item, o lo vivo en el URL de mock (recobros intake sin file). */
async function fuenteDelItem(item: Comprobante): Promise<Blob> {
  return item.file ?? (await (await fetch(item.imgUrl)).blob());
}

/** Gira el bitmap para un WebP (o lanza; el catch del giro avisa). */
async function blobGiradoDe(
  bmp: ImageBitmap,
  grados: GiroManual,
  crear: typeof crearReal,
): Promise<Blob> {
  const lienzo = lienzoGirado(bmp, grados, crear);
  if (!lienzo) throw new Error("sin contexto 2d");
  const girado = await new Promise<Blob | null>((res) =>
    lienzo.toBlob(res, "image/webp", CALIDAD_WEBP),
  );
  if (!girado) throw new Error("sin blob girado");
  return girado;
}

/** ponytail: el previo acompaña al giro (con orientación rancia el próximo
    recorte manual ensancharía sobre píxeles viejos: se aborta, no se mezcla). */
async function previoGirado(
  item: Comprobante,
  grados: GiroManual,
  cargar: typeof cargarReal,
  crear: typeof crearReal,
): Promise<Blob | null> {
  if (!item.previoDocAligner) return null;
  const girado = await girarBlob(item.previoDocAligner, grados, cargar, crear);
  if (!girado) throw new Error("sin previo girado");
  return girado;
}

/** Reprograma la relectura: el OCR corre una sola vez tras la quietud. */
function programarRelectura(id: number, girado: Blob, deps?: DepsOcr): void {
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
    const cargar = cargarVigente(deps);
    const crear = crearVigente(deps);
    const bmp = await cargar(await fuenteDelItem(item), { imageOrientation: "from-image" });
    try {
      const girado = await blobGiradoDe(bmp, grados, crear);
      const giradoPrevio = await previoGirado(item, grados, cargar, crear);
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
      programarRelectura(id, girado, deps);
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

/** El OCR del lote/espera: flap 250ms×480 — nunca queda huérfano en el turno. */
async function drenarSiLaColaTrabaja(): Promise<void> {
  if (state.colaEnProceso) await esperarDrenaje();
}

/** OCR del blob girado; "" si el módulo cargó roto (mejor vacío que rancio). */
async function textoDeOcr(blob: Blob, deps?: DepsOcr): Promise<string> {
  const ocr = await import("./ocr").catch((): null => null);
  return ocr ? await ocr.extraerTexto(blob, deps) : "";
}

/** Reabre el lote de extracción: el monto no-manual lo recaptura tras la quietud. */
async function reabrirMonto(): Promise<void> {
  // ponytail: dinámico a propósito — rotar es estático en sheets y extract
  // importa sheets: un estático aquí haría ciclo sheets→rotar→extract→sheets.
  const mod = await import("./extract").catch((): null => null);
  // Si la cola trabaja se espera a que drene: el batch excluye al "procesando"
  // y sin espera el monto quedaba huérfano hasta el próximo disparo.
  await drenarSiLaColaTrabaja();
  try {
    mod?.extraerPendientes();
  } catch {
    /* la relectura conserva el texto leído */
  }
}

/** Tras un OCR caído: vacía el texto rancio y repone el item en ok si sigue vivo. */
async function restaurarSinTexto(item: Comprobante, id: number): Promise<void> {
  // ponytail: sin relectura no vale el texto viejo (es de otra orientación).
  if (buscarSlot(id)) {
    item.textoOcr = "";
    if (!item.montoManual) item.montoCents = null;
    item.estado = "ok";
    await import("../ui/sheets").then((m) => m.renderHojas()).catch(() => {});
  }
  avisar("No se pudo releer el texto girado.");
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
    await drenarSiLaColaTrabaja();
    if (!buscarSlot(id)) return; // el item murió en la espera: nada que releer
    const texto = await textoDeOcr(blob, deps);
    // ponytail: ok ANTES del lote (candidatos exige ok: en procesando se autoexcluía).
    if (buscarSlot(id)) {
      item.textoOcr = sanear(texto);
      item.estado = "ok";
      renderHojas();
    }
    // No-manual: el total lo reabre el lote (pinta solo si aplica; el ok y el
    // texto ya quedaron pintados arriba).
    if (!item.montoManual && buscarSlot(id)) {
      item.montoCents = null;
      renderHojas(); // el lote puede ser no-op: sin esto el badge viejo miente
      await reabrirMonto();
    }
  } catch {
    await restaurarSinTexto(item, id);
  }
}
