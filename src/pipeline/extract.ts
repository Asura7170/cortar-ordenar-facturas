/* Extracción del TOTAL: regex offline — 1 monto distinto = total sin red;
   ≥2 distintos, signo previo (-/() o sin montos = manual. Auto al drenar la
   cola + botón #btnCalcular. Solo completa montos en null no-manuales: lo manual
   siempre gana. La suma total la hace el código (sumaTotal). */
import { buscarSlot, state } from "../state";
import type { Cents, Comprobante } from "../types";
import { aplanar, parsearMonto } from "../ui/monto";
import { actualizarMontoCelda, renderHojas } from "../ui/sheets";
import { avisar, avisarError, sanear } from "../utils";

const MONEY_RE = /(?:Bs\.?|BOB|\$)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)/g;

export interface Candidato {
  readonly valor: string;
  /** `-`/`(` justo antes del match: nota de crédito, no se auto-fija. */
  readonly previo: string;
}

/** Precios con 2 decimales (cuentas y precios ×4 decimales no matchean). */
export function extractCandidates(contenido = ""): Candidato[] {
  MONEY_RE.lastIndex = 0;
  const out: Candidato[] = [];
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(contenido)) !== null) {
    out.push({
      valor: m[1] ?? "",
      // Un "-" de un run separador no es signo (solo vale sin guion previo).
      previo:
        /(?:^|[^-])(-)\s*$|(\()\s*$/.exec(contenido.slice(0, m.index))?.slice(1).find(Boolean) ??
        "",
    });
  }
  return out;
}

// ponytail: fast-path offline — 1 único distinto (repetido N veces vale) => total sin red.
// Con signo previo (- o paréntesis contable) no auto-fija: queda manual.
export function extraerRapidoCents(contenido = ""): Cents | null {
  let unico: Cents | null = null;
  let vistos = 0;
  for (const c of extractCandidates(contenido)) {
    if (c.previo !== "") return null;
    const cents = parsearMonto(c.valor);
    if (cents === null) continue;
    if (vistos === 0) unico = cents;
    else if (unico !== cents) return null;
    vistos++;
  }
  return vistos > 0 ? unico : null;
}

/** Candidatos: OK con OCR, sin monto y sin marca manual. */
export function candidatos(): Comprobante[] {
  return aplanar().filter(
    (c) => c.estado === "ok" && c.montoCents === null && !c.montoManual && c.textoOcr.trim() !== "",
  );
}

/** Normalizado sin tope: el monto se clasifica sobre el texto completo. */
export function limpiarTextoCompleto(s: string): string {
  return sanear(s).replace(/\s+/g, " ").trim();
}

export interface ItemLote {
  readonly idx: number;
  readonly id: number;
  readonly texto: string;
}

/** Aplica montos solo a comprobantes vivos que sigan en null. Devuelve aplicados. */
// ponytail: el borrador en curso gana a la pasada en vuelo (igual que lo manual
// confirmado). Sin foco también vale: el change válido commitea en el acto, así
// que un input no vacío en celda null es borrador inválido tras blur. Sin estado
// extra: se lee del DOM.
function montoEnEdicion(id: number): boolean {
  const a = document.activeElement;
  if (
    a instanceof HTMLInputElement &&
    a.dataset["accion"] === "monto" &&
    a.closest(".cell")?.getAttribute("data-id") === String(id)
  )
    return true;
  const input = document.querySelector(`.cell[data-id="${id}"] input.cell-monto`);
  return input instanceof HTMLInputElement && input.value !== "";
}

export function aplicarTotales(
  items: readonly ItemLote[],
  montos: ReadonlyMap<number, Cents | null>,
): number {
  let aplicados = 0;
  for (const it of items) {
    const cents = montos.get(it.idx) ?? null;
    if (cents === null) continue;
    if (montoEnEdicion(it.id)) continue; // el borrador en curso gana
    const slot = buscarSlot(it.id);
    if (!slot) continue; // limpiado/quitado en el ínterin: no resucita
    const actual = slot.hoja.slots[slot.idx];
    if (!actual || actual.montoCents !== null) continue; // manual ganó en el ínterin
    if (limpiarTextoCompleto(actual.textoOcr) !== it.texto) continue; // girado: rancio
    actual.montoCents = cents;
    aplicados++;
  }
  return aplicados;
}

/** Cómputo puro del lote (sin DOM ni estado): candidatos → items → mapa. */
export type LoteListo =
  | { readonly tipo: "sin-candidatos" }
  | { readonly tipo: "sin-texto" }
  | { readonly tipo: "sin-totales" }
  | {
      readonly tipo: "listo";
      readonly items: ItemLote[];
      readonly mapa: ReadonlyMap<number, Cents>;
    };

/** Clasifica el lote sin efectos (testeable sin fixture). */
export function computarLote(lista: readonly Comprobante[]): LoteListo {
  if (lista.length === 0) return { tipo: "sin-candidatos" };
  const items: ItemLote[] = [];
  lista.forEach((c, i) => {
    const texto = limpiarTextoCompleto(c.textoOcr);
    if (texto !== "") items.push({ idx: i + 1, id: c.id, texto });
  });
  if (items.length === 0) return { tipo: "sin-texto" };
  const mapa = new Map<number, Cents>();
  for (const it of items) {
    const r = extraerRapidoCents(it.texto);
    if (r !== null) mapa.set(it.idx, r);
  }
  if (mapa.size === 0) return { tipo: "sin-totales" };
  return { tipo: "listo", items, mapa };
}

/** Aviso del lote vacío: null = silencio (sin-texto o no forzado). El
    sin-totales es fallo (toast rojo); el sin-pendientes es información. */
function avisoVacio(
  tipo: LoteListo["tipo"],
  opciones?: { forzado?: boolean },
): { texto: string; esError: boolean } | null {
  if (!opciones?.forzado) return null;
  if (tipo === "sin-candidatos")
    return { texto: "Sin pendientes (todo ya tiene total o es manual).", esError: false };
  if (tipo === "sin-totales")
    return {
      texto: "Sin totales para leer: revisá manualmente o recortá de nuevo.",
      esError: true,
    };
  return null; // sin-texto: silencioso aunque sea forzado
}

/** Mensaje final del lote (puro): éxito total con aviso previo lo restaura. */
export function mensajeLote(ok: number, total: number, avisoPrevio: string): string {
  if (ok === total && avisoPrevio.trim() !== "") return avisoPrevio;
  return `Local: ${ok}/${total} totales.`;
}

/** Parchea las celdas del lote (best-effort: nunca aborta). */
function parchearCeldas(items: readonly ItemLote[], mapa: ReadonlyMap<number, Cents>): void {
  for (const it of items) {
    if (mapa.get(it.idx) != null) {
      try {
        actualizarMontoCelda(it.id);
      } catch {
        /* el parche nunca aborta el lote */
      }
    }
  }
}

/** Gate de cola en proceso (con aviso si es forzado): true = no extraer ahora. */
function bloqueadoPorCola(opciones?: { forzado?: boolean; desdeCola?: boolean }): boolean {
  if (state.colaEnProceso && !opciones?.desdeCola) {
    if (opciones?.forzado) avisar("OCR en curso: los totales se calculan al terminar.");
    return true;
  }
  return false;
}

/** Re-chequeo regex de los null no-manuales (botón #btnCalcular, giro y drenado de la
    cola): 1 distinto fija el total; ≥2 distintos o signo previo quedan manual.
    Síncrono y sin red: nunca lanza. */
export function extraerPendientes(opciones?: { forzado?: boolean; desdeCola?: boolean }): void {
  if (bloqueadoPorCola(opciones)) return;
  const lote = computarLote(candidatos());
  if (lote.tipo !== "listo") {
    const vacio = avisoVacio(lote.tipo, opciones);
    if (vacio !== null) {
      if (vacio.esError) avisarError(vacio.texto);
      else avisar(vacio.texto);
    }
    return;
  }
  // Solo el título del toast vivo: la pila completa concatenaba títulos ajenos,
  // detalles y toasts en despedida (el éxito total restauraba basura).
  const avisoPrevio =
    document.querySelector("#aviso .toast:not([data-grupo]):not(.saliendo) .toast-titulo")
      ?.textContent ?? "";
  const ok = aplicarTotales(lote.items, lote.mapa);
  parchearCeldas(lote.items, lote.mapa);
  if (ok > 0) {
    try {
      renderHojas(); // badges + #montoTotal con suma local exacta
    } catch {
      /* el parche nunca aborta el lote */
    }
  }
  avisar(mensajeLote(ok, lote.items.length, avisoPrevio));
}
