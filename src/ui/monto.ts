/* Montos en cents (suma exacta) + colecciones de comprobantes. */
import { MONEDAS, state } from "../state";
import type { Cents, Comprobante, Hoja, Moneda } from "../types";
import { getEl } from "../utils";

const montoEl: HTMLElement = getEl("montoTotal");

export function formatearMoneda(cents: Cents): string {
  const m = MONEDAS[state.moneda] ?? MONEDAS.USD;
  return `${m.simbolo} ${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Texto US ("1,234.56", "500") → cents. Null si inválido.
 * Solo coma de miles (en grupos de 3, con decimal obligatorio) y punto decimal.
 * Es el formato del fast-path regex (extract.ts).
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

const TEXTO_INICIAL = "Calcular totales";

// Botones de acción de la sidebar que se apagan con el lote vacío. Ajustes
// fuera: configurar siempre es posible (regla del usuario).
const BOTONES_LOTE = ["btnCalcular", "btnWord", "btnPdf", "btnImprimir", "btnLimpiar"];

// ponytail: el botón es el estado (con-monto/total, siempre visible): cada
// renderMonto lo sincroniza, sin importar qué camino mutó las hojas.
function pintarBarraBoton(): void {
  const btn = document.getElementById("btnCalcular");
  if (!(btn instanceof HTMLButtonElement)) return;
  const total = totalItems();
  const hechos = aplanar().filter((c) => c.montoCents !== null).length;
  btn.style.setProperty("--progreso", String(total > 0 ? hechos / total : 0));
  // ponytail: vaciar no ofrece nada con lote vacío (confirmaría nada); por la
  // misma razón ninguna otra acción de la sidebar tampoco. Único escritor de
  // .disabled de estos ids en src/ (grep previo): el sync no pisa a nadie.
  for (const id of BOTONES_LOTE) {
    const boton = document.getElementById(id);
    if (boton instanceof HTMLButtonElement) boton.disabled = total === 0;
  }
  // ponytail: etiqueta y cuenta en spans separados (la etiqueta parte en 2
  // líneas y la caja de la cuenta queda fija; así el icono no se corre).
  const progreso = hechos > 0;
  btn.classList.toggle("con-monto", progreso);
  const etiqueta = progreso ? "Montos extraídos: " : TEXTO_INICIAL;
  const cuenta = progreso ? `${hechos}/${total}` : "";
  const textos = btn.querySelectorAll(".calculo-txt");
  if (textos.length === 0) {
    btn.textContent = etiqueta + cuenta; // fixture: botón sin spans
  } else {
    textos.forEach((txt) => {
      txt.textContent = etiqueta;
    });
    btn.querySelectorAll(".calculo-cuenta").forEach((cta) => {
      cta.textContent = cuenta;
    });
  }
}

/** Largo del prefijo común posicional de dos textos (la ruleta lo deja fijo). */
export function prefijoComun(viejo: string, texto: string): number {
  let k = 0;
  while (k < viejo.length && k < texto.length && viejo[k] === texto[k]) k += 1;
  return k;
}

/** Sufijo viejo alineado por la derecha al ancho del nuevo (valor posicional). */
export function alinearSufijos(sufV: string, sufN: string): string {
  return sufV.length > sufN.length
    ? sufV.slice(sufV.length - sufN.length)
    : sufV.padStart(sufN.length);
}

/** Span quieto del prefijo común y de los separadores. */
export function spanFijo(ch: string): HTMLElement {
  const s = document.createElement("span");
  s.textContent = ch;
  return s;
}

// ponytail: el total es una ruleta (una tira vertical por dígito, adaptada del
// prototipo p26). La dirección la dicta la progresión numérica — subir SIEMPRE
// avanza hacia arriba, también en posiciones nuevas (el viejo pop de
// .monto-nuevo caía desde arriba: esa era la rueda "hacia abajo" al crecer).
let previoTotal: Cents | null = null;
let textoRegla: string | null = null;
let monedaRegla: Moneda | null = null;
let rafId: number | null = null;

const VUELTAS = 1; // barridos extra por rueda (p26 usa 3 con botón manual)
const DURACION = 700; // ms por posición (p26: 1400, un giro por clic)
const ESCALON = 60; // retardo izq→der (p26: 90)
const BLUR_MAXIMO = 3; // p26 usa 3
const FILTROS = 14; // 12 enteros + 2 decimales máx de parsearMonto: sin compartir ranura

/** Desplazamiento en células de una rueda d1→d2 (positivo sube, negativo baja). */
export function pasos(d1: number, d2: number, sube: boolean): number {
  const min = (((sube ? d2 - d1 : d1 - d2) % 10) + 10) % 10;
  const vueltas = (min === 0 ? 10 : min) + VUELTAS * 10;
  return sube ? vueltas : -vueltas;
}

function esDigito(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Defs con los filtros feGaussianBlur verticales (el blur de la referencia); 1× por página. */
function garantizarDefs(): void {
  if (document.getElementById("monto-blur-defs")) return;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("id", "monto-blur-defs");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const defs = document.createElementNS(NS, "defs");
  for (let i = 0; i < FILTROS; i += 1) {
    const f = document.createElementNS(NS, "filter");
    f.setAttribute("id", `monto-blur-${i}`);
    f.setAttribute("x", "-20%");
    f.setAttribute("y", "-150%");
    f.setAttribute("width", "140%");
    f.setAttribute("height", "400%");
    const fe = document.createElementNS(NS, "feGaussianBlur");
    fe.setAttribute("id", `monto-blur-fe-${i}`);
    fe.setAttribute("stdDeviation", "0 0");
    f.append(fe);
    defs.append(f);
  }
  svg.append(defs);
  document.body.append(svg);
}

/** Blur vertical del filtro `i` mientras la tira gira (decae a 0 con rAF). */
function blurEn(i: number, y: number): void {
  const fe = document.getElementById(`monto-blur-fe-${i}`);
  if (fe) fe.setAttribute("stdDeviation", `0 ${y}`);
}

/** blanquea las ranuras: sin residuo tras cancelar una rueda o armar plano. */
function resetearBlur(): void {
  for (let i = 0; i < FILTROS; i += 1) blurEn(i, 0);
}

/** translateY (px, negativo) que centra la célula `k` en la ventana; el origen de la tira es `base`. */
export function desplazamiento(base: number, k: number, cell: number): number {
  return -((k - base) * cell);
}

/** Índice absoluto de la célula visible según la matriz computada; null si no parsea (jsdom/plaino). */
export function celdaDesdeMatriz(matrix: string, base: number, cell: number): number | null {
  const m = /matrix\(([^)]*)\)/.exec(matrix);
  if (m === null || !Number.isFinite(cell) || cell <= 0) return null;
  const y = parseFloat((m[1] ?? "").split(",").at(-1) ?? "");
  return Number.isFinite(y) ? base + Math.round(-y / cell) : null;
}

interface Cola {
  readonly col: HTMLElement;
  readonly tira: HTMLElement;
  readonly inicio: number;
  /** Índice de la célula visible al aterrizar (fin % 10 === dígito nuevo). */
  readonly fin: number;
  /** data-i de la primera célula: todo transform se rebasa con esto (invariante p26). */
  readonly base: number;
  /** Ranura de blur si gira; -1 si estática (las estáticas no portan filtro). */
  blurIdx: number;
}

/** Tira vertical con las células de todo el recorrido (+2 reservas); el transform lo pone quien mide (tras medir cell). */
function crearCola(inicio: number, fin: number): Cola {
  const col = document.createElement("span");
  col.className = "monto-col";
  const tira = document.createElement("span");
  tira.className = "monto-tira";
  const base = Math.min(inicio, fin) - 2;
  for (let kk = base; kk <= Math.max(inicio, fin) + 2; kk += 1) {
    const d = document.createElement("span");
    d.className = "monto-digito";
    d.dataset["i"] = String(kk);
    d.textContent = String(((kk % 10) + 10) % 10);
    tira.append(d);
  }
  col.append(tira);
  return { col, tira, inicio, fin, base, blurIdx: -1 };
}

/** Construcción plana: cada dígito es una tira clavada en su número (punto de partida de futuras ruedas). */
function mostrarPlano(texto: string): void {
  garantizarDefs();
  resetearBlur();
  montoEl.setAttribute("aria-label", texto);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  const hijos: Node[] = [];
  const colas: Cola[] = [];
  for (const ch of texto) {
    if (esDigito(ch)) {
      const col = crearCola(+ch, +ch);
      colas.push(col);
      hijos.push(col.col);
    } else {
      hijos.push(spanFijo(ch));
    }
  }
  montoEl.replaceChildren(...hijos);
  const primera = colas[0];
  const cell = primera ? primera.col.offsetHeight || 24 : 0;
  for (const c of colas) {
    c.col.dataset["muestra"] = String(c.inicio);
    c.tira.style.transition = "none";
    c.tira.style.transform = `translateY(${desplazamiento(c.base, c.inicio, cell)}px)`;
  }
}

export function renderMonto(): void {
  pintarBarraBoton();
  const total = sumaTotal();
  const texto = formatearMoneda(total);
  // ponytail: llamada duplicada (tick + renderHojas final) no toca el DOM:
  // así no mata la animación en vuelo antes del primer paint.
  if (textoRegla === texto) {
    previoTotal = total;
    return;
  }
  // Primera vez, mismos cents o cambio de moneda: plano, sin rueda.
  if (previoTotal === null || total === previoTotal || state.moneda !== monedaRegla) {
    previoTotal = total;
    monedaRegla = state.moneda;
    textoRegla = texto;
    mostrarPlano(texto);
    return;
  }
  const sube = total > previoTotal;
  previoTotal = total;
  monedaRegla = state.moneda;
  const viejo = textoRegla as string; // texto distinto ⇒ no null: una rueda/plano previo lo fijó
  textoRegla = texto;
  montoEl.setAttribute("aria-label", texto);
  // Prefijo común quieto; el resto se alinea a la derecha por valor posicional.
  const k = prefijoComun(viejo, texto);
  const sufV = viejo.slice(k);
  const sufN = texto.slice(k);
  const alineado = alinearSufijos(sufV, sufN);
  const hijos: Node[] = [];
  const colas: Cola[] = [];
  for (let i = 0; i < k; i += 1) {
    // ponytail: i < k ≤ texto.length ⇒ in-bounds (el ?? "" era rama muerta).
    hijos.push(spanFijo(texto[i] as string));
  }
  sufN.split("").forEach((ch, j) => {
    // ponytail: alinearSufijos SIEMPRE retorna sufN.length ⇒ j in-bounds.
    const v = alineado[j] as string;
    if (!esDigito(ch)) {
      hijos.push(spanFijo(ch)); // separador que aparece (coma) o marca de moneda
      return;
    }
    const d1 = esDigito(v) ? +v : 0;
    const fin = d1 === +ch ? d1 : d1 + pasos(d1, +ch, sube);
    const col = crearCola(d1, fin);
    colas.push(col);
    hijos.push(col.col);
  });
  // Retarget suave: posición visual actual de las tiras viejas (derecha→izquierda
  // empareja los dígitos posicionalmente, como el odómetro). Antes del rebuild.
  const previas: { matriz: string; base: number }[] = [];
  for (const t of montoEl.querySelectorAll<HTMLElement>(".monto-tira")) {
    const primeraTira = t.querySelector<HTMLElement>(".monto-digito");
    if (primeraTira?.dataset["i"] === undefined) continue;
    previas.push({ matriz: getComputedStyle(t).transform, base: +primeraTira.dataset["i"] });
  }
  montoEl.replaceChildren(...hijos);
  const primera = colas[0];
  const cell = primera ? primera.col.offsetHeight || 24 : 0;
  const reducir =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let giran = 0;
  for (const c of colas) {
    c.col.dataset["muestra"] = String(c.fin);
    if (c.fin !== c.inicio) {
      c.blurIdx = giran % FILTROS;
      c.tira.style.filter = `url(#monto-blur-${c.blurIdx})`;
      giran += 1;
    }
  }
  if (reducir) {
    for (const c of colas) {
      c.tira.style.transition = "none";
      c.tira.style.transform = `translateY(${desplazamiento(c.base, c.fin, cell)}px)`;
    }
    return;
  }
  // Punto de partida: la posición visual actual (retarget en plena rueda, con
  // clamp para nunca salir de la tira) o el dígito viejo en el primer armado.
  for (const [i, c] of colas.entries()) {
    if (c.fin === c.inicio) {
      c.tira.style.transition = "none";
      c.tira.style.transform = `translateY(${desplazamiento(c.base, c.fin, cell)}px)`;
      continue;
    }
    let arranque = c.inicio;
    const previa = previas[previas.length - colas.length + i];
    if (previa !== undefined) {
      const kk = celdaDesdeMatriz(previa.matriz, previa.base, cell);
      if (kk !== null) {
        arranque = Math.min(Math.max(kk, c.base + 1), Math.max(c.inicio, c.fin) + 1);
      }
    }
    c.tira.style.transition = "none";
    c.tira.style.transform = `translateY(${desplazamiento(c.base, arranque, cell)}px)`;
  }
  if (colas.every((c) => c.fin === c.inicio)) return;
  void montoEl.offsetWidth; // reflow: clava el punto de partida
  colas.forEach((c, i) => {
    if (c.fin === c.inicio) return;
    c.tira.style.transition = `transform ${DURACION}ms cubic-bezier(0.16, 1, 0.3, 1) ${i * ESCALON}ms`;
    c.tira.style.transform = `translateY(${desplazamiento(c.base, c.fin, cell)}px)`;
  });
  if (rafId !== null) cancelAnimationFrame(rafId);
  resetearBlur();
  const t0 = performance.now();
  const maximo = (colas.length - 1) * ESCALON + DURACION;
  const tick = (): void => {
    const t = performance.now() - t0;
    colas.forEach((c, i) => {
      if (c.blurIdx < 0) return;
      const local = Math.min(1, Math.max(0, (t - i * ESCALON) / DURACION));
      blurEn(c.blurIdx, +(BLUR_MAXIMO * (1 - local)).toFixed(2));
    });
    if (t < maximo + 40) {
      rafId = requestAnimationFrame(tick);
    } else {
      colas.forEach((c) => {
        if (c.blurIdx >= 0) blurEn(c.blurIdx, 0);
      });
      rafId = null;
    }
  };
  rafId = requestAnimationFrame(tick);
}
