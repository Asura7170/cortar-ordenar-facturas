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
 * Texto US ("1,234.56", "500") → cents. Null si inválido.
 * Solo coma de miles (en grupos de 3, con decimal obligatorio) y punto decimal.
 * Es el formato que entregará el LLM (extract.ts futuro).
 */
export function parsearMonto(texto: string): Cents | null {
  const s = texto.trim().replace(/[\s$€£]/g, "");
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  // ponytail: miles con coma exigen decimal con punto ("1,234" solo → escribir 1234).
  if (!m || ((m[1] ?? "").includes(",") && m[2] === undefined)) return null;
  const entera = (m[1] ?? "").replace(/,/g, "");
  if (!/^\d{1,12}$/.test(entera)) return null;
  return Number(entera) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
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

// ponytail: el total se anima por dígito (sube = cae de arriba, baja = cae de
// abajo); sin cambio no hay animación y el texto queda plano.
let previoTotal: Cents | null = null;

export function renderMonto(): void {
  const total = sumaTotal();
  const texto = formatearMoneda(total);
  // ponytail: la llamada duplicada (tick + renderHojas final) no toca el DOM:
  // así no mata la animación en vuelo antes del primer paint.
  if (montoEl.textContent === texto) {
    previoTotal = total;
    return;
  }
  if (previoTotal === null || total === previoTotal) {
    previoTotal = total;
    montoEl.classList.remove("is-animando");
    delete montoEl.dataset["dir"];
    montoEl.textContent = texto;
    return;
  }
  const dir = total > previoTotal ? "-1" : "1";
  previoTotal = total;
  montoEl.dataset["dir"] = dir;
  montoEl.replaceChildren(
    ...texto.split("").map((ch, i) => {
      const s = document.createElement("span");
      s.className = "monto-digito";
      s.style.setProperty("--i", String(Math.min(i, 6)));
      s.textContent = ch;
      return s;
    }),
  );
  montoEl.classList.remove("is-animando");
  void montoEl.offsetWidth;
  montoEl.classList.add("is-animando");
}
