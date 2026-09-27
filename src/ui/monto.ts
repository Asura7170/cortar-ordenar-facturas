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

const TEXTO_BOTON_IA = "$ Extraer montos $";

// ponytail: el botón es el estado (con-monto/total, siempre visible): cada
// renderMonto lo sincroniza, sin importar qué camino mutó las hojas.
function pintarBarraBoton(): void {
  const btn = document.getElementById("btnIA");
  if (!(btn instanceof HTMLButtonElement)) return;
  const total = totalItems();
  const hechos = aplanar().filter((c) => c.montoCents !== null).length;
  btn.style.setProperty("--progreso", String(total > 0 ? hechos / total : 0));
  btn.textContent = `${TEXTO_BOTON_IA} · ${hechos}/${total}`;
}

// ponytail: el total es un odómetro (rueda cada posición que cambia, rápido
// a la derecha y lento a la izquierda); sin cambio no hay animación.
let previoTotal: Cents | null = null;

export function renderMonto(): void {
  pintarBarraBoton();
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
    delete montoEl.dataset["dir"];
    montoEl.textContent = texto;
    return;
  }
  const dir = total > previoTotal ? "-1" : "1";
  previoTotal = total;
  // Prefijo común quieto; el resto se alinea a la derecha por valor posicional.
  const viejo = montoEl.textContent ?? "";
  let k = 0;
  while (k < viejo.length && k < texto.length && viejo[k] === texto[k]) k++;
  const sufV = viejo.slice(k);
  const sufN = texto.slice(k);
  const acolchado = sufV.padStart(sufN.length);
  const fijos: HTMLElement[] = [];
  for (let i = 0; i < k; i++) {
    const s = document.createElement("span");
    s.textContent = texto[i] ?? "";
    fijos.push(s);
  }
  montoEl.dataset["dir"] = dir;
  montoEl.replaceChildren(
    ...fijos,
    ...sufN.split("").map((ch, j) => {
      const v = acolchado[j] ?? " ";
      if (v === ch) {
        const s = document.createElement("span");
        s.textContent = ch;
        return s;
      }
      if (v === " ") {
        const s = document.createElement("span");
        s.className = "monto-nuevo";
        s.textContent = ch;
        return s;
      }
      const r = document.createElement("span");
      r.className = "monto-rodillo";
      const tira = document.createElement("span");
      tira.className = "monto-desplaza";
      tira.dataset["viejo"] = v;
      tira.style.setProperty("--p", String(Math.min(sufN.length - 1 - j, 6)));
      const nuevo = document.createElement("span");
      nuevo.textContent = ch;
      tira.append(nuevo);
      r.append(tira);
      return r;
    }),
  );
}
