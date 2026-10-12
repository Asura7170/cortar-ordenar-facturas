/* Extracción del TOTAL: regex offline — 1 monto distinto = total sin red;
   ≥2 distintos, signo previo (-/() o sin montos = manual. Auto al drenar la
   cola + botón #btnIA. Solo completa montos en null no-manuales: lo manual
   siempre gana. La suma total la hace el código (sumaTotal). */
import { buscarSlot, state } from "../state";
import type { Cents, Comprobante } from "../types";
import { aplanar, parsearMonto } from "../ui/monto";
import { actualizarMontoCelda, renderHojas } from "../ui/sheets";
import { sanear } from "../utils";

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
      previo: /([-(])\s*$/.exec(contenido.slice(0, m.index))?.[1] ?? "",
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

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

/** Re-chequeo regex de los null no-manuales (botón #btnIA, giro y drenado de la
    cola): 1 distinto fija el total; ≥2 distintos o signo previo quedan manual.
    Síncrono y sin red: nunca lanza. */
export function extraerPendientes(opciones?: { forzado?: boolean; desdeCola?: boolean }): void {
  if (state.colaEnProceso && !opciones?.desdeCola) {
    if (opciones?.forzado) avisar("OCR en curso: los totales se calculan al terminar.");
    return;
  }
  const lista = candidatos();
  if (lista.length === 0) {
    if (opciones?.forzado) avisar("Sin pendientes (todo ya tiene total o es manual).");
    return;
  }
  const items: ItemLote[] = [];
  lista.forEach((c, i) => {
    const texto = limpiarTextoCompleto(c.textoOcr);
    if (texto !== "") items.push({ idx: i + 1, id: c.id, texto });
  });
  if (items.length === 0) return;
  const avisoPrevio = document.getElementById("aviso")?.textContent ?? "";
  const mapa = new Map<number, Cents | null>();
  for (const it of items) {
    const r = extraerRapidoCents(it.texto);
    if (r !== null) mapa.set(it.idx, r);
  }
  if (mapa.size === 0) {
    if (opciones?.forzado) avisar("Sin totales para leer: revisá manualmente o recortá de nuevo.");
    return;
  }
  const ok = aplicarTotales(items, mapa);
  for (const it of items) {
    if (mapa.get(it.idx) != null) {
      try {
        actualizarMontoCelda(it.id);
      } catch {
        /* el parche nunca aborta el lote */
      }
    }
  }
  if (ok > 0) renderHojas(); // badges + #montoTotal con suma local exacta
  // Éxito total con aviso previo: se restaura (este aviso no lo pisa).
  if (ok === items.length && avisoPrevio.trim() !== "") avisar(avisoPrevio);
  else avisar(`Local: ${ok}/${items.length} totales.`);
}
