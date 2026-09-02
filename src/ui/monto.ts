/* Montos en cents (suma exacta) + colecciones de comprobantes. */
import { MONEDAS, state } from '../state';
import type { Cents, Comprobante, Hoja } from '../types';
import { getEl } from '../utils';

const montoEl: HTMLElement = getEl('montoTotal');

export function formatearMoneda(cents: Cents): string {
  const m = MONEDAS[state.moneda] ?? MONEDAS.USD;
  return `${m.simbolo} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function itemsDe(hoja: Hoja): Comprobante[] {
  return Iterator.from(hoja.slots).filter((c) => c !== null).toArray();
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
