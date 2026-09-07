/* Montos en cents (suma exacta) + colecciones de comprobantes. */
import { MONEDAS, state } from "../state";
import type { Cents, Comprobante, Hoja } from "../types";
import { getEl } from "../utils";

const montoEl: HTMLElement = getEl("montoTotal");

export function formatearMoneda(cents: Cents): string {
  const m = MONEDAS[state.moneda] ?? MONEDAS.USD;
  return `${m.simbolo} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Texto ("1,234.56", "1234,56", "500") → cents. Null si inválido.
 * El último ./, con 1-2 dígitos es el decimal; el resto son miles.
 */
// ponytail: "1,234" (3 dígitos = miles sin decimales) se rechaza: se escribe 1234.
export function parsearMonto(texto: string): Cents | null {
  const s = texto.trim().replace(/[\s$€£]/g, "");
  if (!/^[0-9.,]+$/.test(s)) return null;
  const sep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let entera = s;
  let decimal = "";
  if (sep >= 0) {
    entera = s.slice(0, sep);
    decimal = s.slice(sep + 1);
    if (!/^\d{1,2}$/.test(decimal)) return null;
  }
  // ponytail: miles con grupos de 3 y separador único ("1,,234" o "1.2.3" → null).
  if (/[.,]/.test(entera) && !/^\d{1,3}((,\d{3})+|(\.\d{3})+)$/.test(entera)) return null;
  entera = entera.replace(/[.,]/g, "");
  if (!/^\d{1,12}$/.test(entera)) return null;
  return Number(entera) * 100 + Number(decimal.padEnd(2, "0"));
}

export function itemsDe(hoja: Hoja): Comprobante[] {
  return Iterator.from(hoja.slots)
    .filter((c) => c !== null)
    .toArray();
}

export function cuentaHoja(hoja: Hoja): number {
  return itemsDe(hoja).length;
}

// Orden visual global (por slots, huecos ignorados).
export function aplanar(): Comprobante[] {
  return Iterator.from(state.hojas).flatMap(itemsDe).toArray();
}

export function sumaTotal(): Cents {
  return aplanar().reduce((acc, c) => acc + (c.montoCents ?? 0), 0);
}

export function totalItems(): number {
  return aplanar().length;
}

export function renderMonto(): void {
  montoEl.textContent = formatearMoneda(sumaTotal());
}
