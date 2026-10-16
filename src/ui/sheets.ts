/* Hojas carta: render de casillas + drag & drop de comprobantes. */
import {
  buscarSlot,
  hojaPorId,
  limpiarHojas,
  obtenerComprobante,
  redistribuir,
  state,
  VENTANA_CIERRE_RECORTE_MS,
} from "../state";
import type { Cents, Comprobante, Hoja, Plantilla } from "../types";
import { NOMBRES_LAYOUT, ORDEN_PLANTILLAS, PLANTILLAS, isLayoutId, layoutDe } from "./layout";
import { cuentaHoja, formatearMoneda, parsearMonto, renderMonto, totalItems } from "./monto";
import { falloIa } from "../pipeline/docaligner";
import { girarYReleer } from "../pipeline/rotar";
import { avisarError, getEl, sanear } from "../utils";

const sheetsEl: HTMLElement = getEl("sheets");
const metaHojas: HTMLElement = getEl("metaHojas");
const statHojas: HTMLElement = getEl("statHojas");
const statComp: HTMLElement = getEl("statComp");
const btnZoom: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoom");
const btnZoomMas: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoomMas");
const btnZoomMenos: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoomMenos");
const btnLupa: HTMLButtonElement = getEl<HTMLButtonElement>("btnLupa");
const lupaEl: HTMLElement = getEl("lupa");
const lupaCanvas: HTMLCanvasElement = getEl<HTMLCanvasElement>("lupaCanvas");
const lupaCtx: CanvasRenderingContext2D | null = lupaCanvas.getContext("2d");
// Tarjeta de subida: visible solo con cero comprobantes.
const tarjetaVacia: HTMLElement = getEl("dropzone");
// Botón de pegado del lote vacío: junto a la tarjeta (lookup perezoso con
// guarda: importar sidebar sería ciclo, y el nodo puede remontarse).
function btnPegarVacio(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("#btnPegar");
}
const canvasEl: HTMLElement = getEl("canvas"); // <main class="canvas" id="canvas"> (fallo fuerte al boot)

/* ---------- Render de casillas (sin innerHTML para datos del usuario) ---------- */

/* X de quitar (Lucide, marcado estático confiable: sin datos de usuario). */
const X_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/* Rotor de giro (marcado estático confiable: sin datos de usuario). */
const GIRAR_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="girar-nucleo"><path d="M15 4.55a8 8 0 0 0 -6 14.9"/><polyline class="girar-aleta" points="9 15 9 20 4 20"/><circle class="punto punto-1" cx="18.37" cy="7.16" r="1" fill="currentColor" stroke="none"/><circle class="punto punto-2" cx="19.94" cy="11" r="1" fill="currentColor" stroke="none"/><circle class="punto punto-3" cx="19.37" cy="15.1" r="1" fill="currentColor" stroke="none"/><circle class="punto punto-4" cx="16.84" cy="18.37" r="1" fill="currentColor" stroke="none"/><circle class="punto punto-5" cx="13" cy="19.94" r="1" fill="currentColor" stroke="none"/></g></svg>';

/* Encuadre de recorte (marcado estático confiable: sin datos de usuario). */
const CROP_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="encuadre"><g class="tercios" stroke-width="0.9" opacity="0"><line x1="10" y1="6" x2="10" y2="18" stroke-dasharray="1.2 1.2"/><line x1="14" y1="6" x2="14" y2="18" stroke-dasharray="1.2 1.2"/><line x1="6" y1="10" x2="18" y2="10" stroke-dasharray="1.2 1.2"/><line x1="6" y1="14" x2="18" y2="14" stroke-dasharray="1.2 1.2"/></g><path class="escuadra-inf" d="M6 2v14a2 2 0 0 0 2 2h14"/><path class="escuadra-sup" d="M18 22V8a2 2 0 0 0-2-2H2"/></g></svg>';

/* Copiar OCR (marcado estático confiable: sin datos de usuario). */
const COPY_SVG: string =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="hoja-atras" d="M4 7v13a1 1 0 0 0 1 1h10"/><g class="hoja-frente"><rect x="8" y="3" width="11" height="14" rx="1"/><g class="lineas-doc" stroke-width="1.5"><line x1="11" y1="7" x2="16" y2="7"/><line x1="11" y1="10" x2="16" y2="10"/><line x1="11" y1="13" x2="14" y2="13"/></g><line class="rayo-scan" x1="9.5" y1="4.5" x2="17.5" y2="4.5" stroke-width="1.5"/><polyline class="check-ok" points="10.5 10.5 12.5 12.5 16 8.5"/></g></svg>';

function celda(
  item: Comprobante | null,
  pos: Plantilla["pos"][number] | undefined,
  slotIdx: number,
  hojaId: number,
): HTMLElement {
  const estilo = pos
    ? `grid-row: ${pos[0]} / span ${pos[3] ?? 1}; grid-column: ${pos[1]} / span ${pos[2]};`
    : "";
  const div = document.createElement("div");
  div.className = "cell";
  div.style.cssText = estilo;
  pintarCelda(div, item, slotIdx, hojaId);
  return div;
}

// El grid-area pertenece al slot, no al contenido: el swap parchea solo 2
// celdas sin reconstruir la grilla entera.
function pintarCelda(
  div: HTMLElement,
  item: Comprobante | null,
  slotIdx: number,
  hojaId: number,
): void {
  div.replaceChildren();
  div.className = "cell";
  delete div.dataset["id"];
  div.dataset["slot"] = String(slotIdx);
  div.dataset["hoja"] = String(hojaId);
  // Solo la celda ocupada es tabulable: así el × se revela por :focus-within.
  div.tabIndex = item === null ? -1 : 0;

  if (!item) {
    pintarCeldaVacia(div, slotIdx, hojaId);
    return;
  }

  div.dataset["id"] = String(item.id);

  if (state.modoOcr) {
    pintarCeldaOcr(div, item);
    return;
  }

  div.classList.add(`cell-${item.estado}`);
  const btn = document.createElement("button");
  btn.className = "cell-remove";
  btn.dataset["accion"] = "quitar";
  btn.title = "Quitar";
  btn.setAttribute("aria-label", "Quitar comprobante");
  btn.innerHTML = X_SVG;
  if (item.estado === "ok") pintarBotonesDeOk(div);
  const img = document.createElement("img");
  img.src = item.imgUrl; // full-res con lazy, sin miniaturas
  img.alt = sanear(item.nombre);
  img.draggable = false;
  img.loading = "lazy";
  img.decoding = "async";
  div.append(img, btn);
  pintarBadgeOMonto(div, item);
}

/** Celda sin comprobante: en OCR queda texto inerte; fuera, botón para pegar. */
function pintarCeldaVacia(div: HTMLElement, slotIdx: number, hojaId: number): void {
  div.classList.add("empty");
  // En modo OCR el pegado por clic está bloqueado: queda el texto inerte.
  if (state.modoOcr) {
    div.textContent = "Vacío";
    return;
  }
  const pegar = document.createElement("button");
  pegar.type = "button";
  pegar.className = "cell-pegar";
  pegar.dataset["accion"] = "pegar";
  pegar.dataset["hoja"] = String(hojaId);
  pegar.dataset["slot"] = String(slotIdx);
  pegar.title = "Pegar la imagen copiada";
  pegar.setAttribute("aria-label", "Pegar la imagen copiada aquí");
  const mas = document.createElement("span");
  mas.className = "cell-pegar-mas";
  mas.setAttribute("aria-hidden", "true");
  mas.textContent = "+";
  const txt = document.createElement("span");
  txt.className = "cell-pegar-txt";
  txt.textContent = "Clic para pegar";
  pegar.append(mas, txt);
  div.append(pegar);
}

/** Celda en modo OCR: `pre` con el texto (con placeholder por estado) y copiar. */
function pintarCeldaOcr(div: HTMLElement, item: Comprobante): void {
  div.classList.add("cell-ocr");
  const pre = document.createElement("pre");
  pre.className = "cell-ocr-text";
  pre.textContent = sanear(
    item.textoOcr ||
      (item.estado === "procesando"
        ? "Procesando…"
        : item.estado === "pendiente"
          ? "Pendiente"
          : "Sin texto OCR"),
  );
  const btn = document.createElement("button");
  btn.className = "cell-remove";
  btn.dataset["accion"] = "copiar-ocr";
  btn.title = "Copiar OCR";
  btn.setAttribute("aria-label", "Copiar OCR");
  btn.innerHTML = COPY_SVG;
  div.append(pre, btn);
}

/** Botones de la celda ok: giro manual ×2 (espejo del ×) + recorte. */
function pintarBotonesDeOk(div: HTMLElement): void {
  // Giro manual (fallback del auto-enderezado): arriba-izquierda, espejo del ×.
  for (const [accion, lado] of [
    ["girar-izq", "izquierda"],
    ["girar-der", "derecha"],
  ] as const) {
    const g = document.createElement("button");
    g.type = "button";
    g.className = `cell-girar cell-${accion}`;
    g.dataset["accion"] = accion;
    g.title = `Girar a la ${lado}`;
    g.setAttribute("aria-label", `Girar a la ${lado}`);
    g.innerHTML = GIRAR_SVG;
    div.append(g);
  }
  // Recorte manual: abajo-izquierda (el badge/monto vive abajo-derecha).
  const r = document.createElement("button");
  r.type = "button";
  r.className = "cell-recortar";
  r.dataset["accion"] = "recortar";
  r.title = "Recortar";
  r.setAttribute("aria-label", "Recortar comprobante");
  r.innerHTML = CROP_SVG;
  div.append(r);
}

/** Badge del total o input de corrección (apertura no destructiva del valor). */
function pintarBadgeOMonto(div: HTMLElement, item: Comprobante): void {
  // En corrección se edita el valor previo (apertura no destructiva); fuera de
  // ok no hay input que mostrar y el badge queda como estaba.
  if (item.montoCents != null && item.id !== editandoMonto) {
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "cell-badge";
    badge.dataset["accion"] = "corregir-monto";
    badge.title = "Total (clic para corregir)";
    badge.textContent = formatearMoneda(item.montoCents);
    div.append(badge);
  } else if (item.estado === "ok") {
    // Sin total legible, el monto se carga a mano (0 o ≥2 montos en el texto).
    const entrada = document.createElement("input");
    entrada.className = "cell-monto";
    entrada.type = "text";
    entrada.inputMode = "decimal";
    entrada.placeholder = "1234.56";
    entrada.title = "Total del comprobante (ej. 1234.56)";
    entrada.setAttribute("aria-label", `Total de ${item.nombre}`);
    entrada.dataset["accion"] = "monto";
    if (item.id === editandoMonto && item.montoCents != null) {
      entrada.value = textoEditable(item.montoCents);
    }
    div.append(entrada);
  }
}

function panelHoja(hoja: Hoja, idx: number): string {
  // innerHTML solo con datos internos (plantillas): nunca nombre/textoOcr del usuario.
  const tarjetas = ORDEN_PLANTILLAS.map((id) => {
    const l = PLANTILLAS[id];
    const fichas = Iterator.from(l.pos)
      .map(
        ([f, c, s, rf]) =>
          `<span class="ficha" style="grid-row:${f} / span ${rf ?? 1};grid-column:${c} / span ${s};"></span>`,
      )
      .toArray()
      .join("");
    const activa = id === hoja.layout ? " active" : "";
    const presionado = id === hoja.layout ? "true" : "false";
    return `<button class="grid-opt${activa}" data-accion="layout" data-hoja="${hoja.id}" data-layout="${id}" title="${NOMBRES_LAYOUT[id]}" aria-pressed="${presionado}">
      <span class="layout-mini" style="grid-template-columns:repeat(${l.cols},1fr);grid-template-rows:repeat(${l.filas},1fr);" aria-hidden="true">${fichas}</span>
      <span class="layout-name">${NOMBRES_LAYOUT[id]}</span>
    </button>`;
  }).join("");
  return `
    <aside class="sheet-panel" aria-label="Distribución de la hoja ${idx + 1}">
      <header class="sheet-panel-head">
        <span class="sheet-panel-title">HOJA ${idx + 1}</span>
        <span class="sheet-panel-count">${cuentaHoja(hoja)}/${layoutDe(hoja.layout).total}</span>
      </header>
      <div class="grid-opts">${tarjetas}</div>
      <button class="apply-all" data-accion="apply-all" data-hoja="${hoja.id}">Aplicar a todas las hojas</button>
    </aside>`;
}

/** Todas las hojas al tope (el fantasma solo aparece en ese caso). */
function todasLlenas(): boolean {
  return (
    state.hojas.length > 0 && state.hojas.every((h) => cuentaHoja(h) >= layoutDe(h.layout).total)
  );
}

/** Fila de una hoja: grilla de celdas + panel + botón de agregar. */
function armarFilaHoja(hoja: Hoja, idx: number): HTMLElement {
  const l = layoutDe(hoja.layout);
  const sheet = document.createElement("article");
  sheet.className = "sheet";
  sheet.dataset["hoja"] = String(hoja.id);
  const grid = document.createElement("div");
  grid.className = "sheet-grid";
  grid.style.cssText = `grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)`;
  l.pos.forEach((p, i) => grid.append(celda(hoja.slots[i] ?? null, p, i, hoja.id)));
  const tag = document.createElement("span");
  tag.className = "sheet-tag";
  tag.textContent = `HOJA ${idx + 1}`;
  sheet.append(tag, grid);

  const row = document.createElement("div");
  row.className = "sheet-row";
  row.dataset["hoja"] = String(hoja.id);
  row.innerHTML = panelHoja(hoja, idx);
  row.insertBefore(sheet, row.firstChild);
  // Columna derecha: panel arriba, botón de agregar debajo (misma columna).
  const lado = document.createElement("div");
  lado.className = "sheet-side";
  const panel = row.querySelector(".sheet-panel");
  if (panel) lado.append(panel);
  const mas = document.createElement("button");
  mas.type = "button";
  mas.className = "btn-sumar";
  mas.dataset["accion"] = "agregar";
  mas.dataset["hoja"] = String(hoja.id);
  mas.title = `Agregar comprobantes a la hoja ${idx + 1}`;
  mas.setAttribute("aria-label", `Agregar comprobantes a la hoja ${idx + 1}`);
  const ico = document.createElement("span");
  ico.className = "btn-sumar-mas";
  ico.setAttribute("aria-hidden", "true");
  ico.textContent = "+";
  mas.append(ico, " Agregar comprobantes");
  lado.append(mas);
  row.append(lado);
  return row;
}

/** Fila fantasma de hoja nueva (solo visual; hereda el layout de la última). */
function armarFilaFantasma(): HTMLElement {
  const ultima = state.hojas[state.hojas.length - 1];
  const l = layoutDe(ultima?.layout ?? "u4x2");
  const fila = document.createElement("div");
  fila.className = "sheet-row";
  fila.dataset["hoja"] = String(HOJA_FANTASMA);
  const fantasma = document.createElement("article");
  fantasma.className = "sheet sheet-fantasma";
  fantasma.dataset["hoja"] = String(HOJA_FANTASMA);
  const grid = document.createElement("div");
  grid.className = "sheet-grid";
  grid.style.cssText = `grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)`;
  l.pos.forEach((p, i) => grid.append(celda(null, p, i, HOJA_FANTASMA)));
  const tag = document.createElement("span");
  tag.className = "sheet-tag";
  tag.textContent = `HOJA ${state.hojas.length + 1} · nueva`;
  fantasma.append(tag, grid);
  const lado = document.createElement("div");
  lado.className = "sheet-side";
  lado.setAttribute("aria-hidden", "true");
  fila.append(fantasma, lado);
  return fila;
}

/* Stats del flanco de marca: cifras que ruedan (--n transitioned) y pulsan al
   cambiar de lote; sin fuga de palabra visible (labels en SR + title). */
let statsPrimerRender = true;
let statsPrevHojas = 0;
let statsPrevComp = 0;
function setStats(hojas: number, comps: number): void {
  metaHojas.toggleAttribute("data-cero", hojas === 0 && comps === 0);
  if (statsPrimerRender) {
    // Better-ui: skip state animations on first render.
    statsPrimerRender = false;
    metaHojas.classList.add("stats-frozen");
    requestAnimationFrame(() => metaHojas.classList.remove("stats-frozen"));
  } else if (hojas !== statsPrevHojas || comps !== statsPrevComp) {
    for (const el of [statHojas, statComp]) {
      el.classList.remove("bump");
    }
    void statHojas.offsetWidth; // reinicia el pop one-shot si estaba en vuelo
    statHojas.classList.add("bump");
    statComp.classList.add("bump");
  }
  statsPrevHojas = hojas;
  statsPrevComp = comps;
  statHojas.style.setProperty("--n-hojas", String(hojas));
  statComp.style.setProperty("--n-comp", String(comps));
}

/** Cuerpo del render (siempre bajo `mutandoHojas`: el swap destruye el foco). */
function renderCuerpo(borrador: BorradorMonto | null): void {
  rectsCache = null;
  const n = totalItems();
  // Stats = lo que está en pantalla: con n===0 (tarjeta vacía) no hay hojas
  // pintadas — la semilla base (main.ts/limpiarHojas) no se cuenta.
  setStats(n === 0 ? 0 : state.hojas.length, n);
  sheetsEl.innerHTML = "";

  if (n === 0) {
    tarjetaVacia.hidden = false;
    const pegar = btnPegarVacio();
    if (pegar) pegar.hidden = false;
    renderMonto();
    return;
  }

  state.hojas.forEach((hoja, idx) => sheetsEl.append(armarFilaHoja(hoja, idx)));
  // Hoja fantasma: solo visual (nunca entra a state.hojas, así no se
  // exporta ni se cuenta). Hereda el layout de la última; al pegar en
  // ella se materializa como hoja real. Va en .sheet-row con la columna
  // vacía para alinear el borde izquierdo con las hojas reales.
  if (!state.modoOcr && todasLlenas()) sheetsEl.append(armarFilaFantasma());
  tarjetaVacia.hidden = true;
  const pegar = btnPegarVacio();
  if (pegar) pegar.hidden = true;
  renderMonto();
  if (borrador) restaurarBorrador(borrador);
}

/** ¿El render puede ir en ViewTransition? (sin borrador/foco/movimiento/cola). */
function usaViewTransition(borrador: BorradorMonto | null): boolean {
  if (borrador) return false;
  // ponytail: con foco dentro de las hojas el render es síncrono (el swap
  // async pierde el foco y rompe la edición en curso).
  if (sheetsEl.contains(document.activeElement)) return false;
  // ponytail: sin ViewTransition con reduced-motion, durante la cola ni durante
  // el intake (los snapshots compiten con el drag/scroll); es solo un adorno.
  const reduceMovimiento = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  if (reduceMovimiento || state.colaEnProceso || state.loteEnCurso) return false;
  return !!document.startViewTransition;
}

export function renderHojas(): void {
  // Durante un arrastre nunca se reconstruye la grilla: el render se pospone.
  if (pointerDrag) {
    renderPendiente = true;
    return;
  }
  // ponytail: el borrador manual sobrevive a los renders de fondo (cola/recálculo/giro).
  const borrador = borradorEnEdicion();
  // ponytail: los borradores sin foco también (inválidos tras blur): se derivan
  // del DOM, sin estado extra que limpiar o que se vuelva rancio.
  const sucios = borradoresVisibles();
  // ponytail: todo change que llegue durante el swap es eco de remoción.
  const render = (): void => {
    bajoMutandoHojas(() => {
      renderCuerpo(borrador);
    });
    restaurarSucios(sucios);
  };
  const usaVT = usaViewTransition(borrador);
  if (usaVT) {
    const t = document.startViewTransition(render);
    t.ready?.catch(() => {});
    t.finished?.catch(() => {});
  } else render();
}

export function soltarRenderPendiente(): void {
  if (!renderPendiente) return;
  renderPendiente = false;
  renderHojas();
}

/* ---------- Acciones sobre hojas ---------- */

export function cambiarLayoutHoja(hojaId: string | number, layoutId: string): void {
  const h = hojaPorId(hojaId);
  if (!h || !isLayoutId(layoutId)) return;
  h.layout = layoutId;
  redistribuir();
  renderHojas();
}

export function aplicarATodas(hojaId: string | number): void {
  const h = hojaPorId(hojaId);
  if (!h) return;
  const layoutId = h.layout;
  state.hojas.forEach((x) => {
    x.layout = layoutId;
  });
  redistribuir(layoutId); // las nuevas también reciben la plantilla propagada
  renderHojas();
}

export function quitarComprobante(id: number): void {
  for (const h of state.hojas) {
    const idx = h.slots.findIndex((c) => c?.id === id);
    if (idx >= 0) {
      const c = h.slots[idx];
      if (c) {
        URL.revokeObjectURL(c.imgUrl);
      }
      h.slots[idx] = null;
      break;
    }
  }
  limpiarHojas();
  renderHojas();
}

function cellById(id: number): HTMLElement | null {
  return sheetsEl.querySelector<HTMLElement>(`.cell[data-id="${id}"]`);
}

// ponytail: Escape descarta el borrador (el render no lo preserva ni lo commitea).
let descartarBorrador = false;

// ponytail: corrección abierta (apertura no destructiva: el estado vale hasta
// el commit; los ids monótonos hacen inofensivo un flag rancio).
let editandoMonto: number | null = null;

// ponytail: check temporal del botón copiar-OCR (1200ms, un timer por botón).
const TIEMPO_COPIADO_MS = 1200;
const copiadoTimers = new WeakMap<HTMLElement, number>();

interface BorradorMonto {
  readonly id: number;
  readonly valor: string;
  readonly inicio: number | null;
  readonly fin: number | null;
  readonly error: boolean;
}

/** Borrador en curso (input de monto con foco): sobrevive a los renders de fondo. */
function borradorEnEdicion(): BorradorMonto | null {
  if (descartarBorrador) return null;
  const a = document.activeElement;
  if (!(a instanceof HTMLInputElement) || a.dataset["accion"] !== "monto") return null;
  const cell = a.closest(".cell");
  const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
  if (!Number.isInteger(id)) return null;
  return {
    id,
    valor: a.value,
    inicio: a.selectionStart,
    fin: a.selectionEnd,
    error: a.classList.contains("monto-error"),
  };
}

/** Borradores visibles sin foco (inválidos tras blur): se capturan del DOM. */
interface BorradorSucio {
  readonly valor: string;
  readonly error: boolean;
}

function borradoresVisibles(): Map<number, BorradorSucio> {
  const sucios = new Map<number, BorradorSucio>();
  const a = document.activeElement;
  sheetsEl.querySelectorAll<HTMLInputElement>("input.cell-monto").forEach((input) => {
    if (input === a || input.value === "") return;
    const cell = input.closest(".cell");
    const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
    if (Number.isInteger(id)) {
      sucios.set(id, {
        valor: input.value,
        error: input.classList.contains("monto-error"),
      });
    }
  });
  return sucios;
}

/** Restaura borradores sin foco tras el render (valor y error, nunca foco: B2). */
function restaurarSucios(sucios: Map<number, BorradorSucio>): void {
  sucios.forEach(({ valor, error }, id) => {
    const input = cellById(id)?.querySelector<HTMLInputElement>("input.cell-monto");
    if (input && document.activeElement !== input) {
      input.value = valor;
      input.classList.toggle("monto-error", error);
      if (error) input.setAttribute("aria-invalid", "true");
    }
  });
}

/** Restaura un borrador tras el render (la celda puede haber cambiado a badge). */
function restaurarBorrador(b: BorradorMonto): void {
  const input = cellById(b.id)?.querySelector<HTMLInputElement>("input.cell-monto");
  if (!input) return;
  input.value = b.valor;
  input.classList.toggle("monto-error", b.error);
  if (b.error) input.setAttribute("aria-invalid", "true");
  input.focus();
  if (b.inicio !== null && b.fin !== null) input.setSelectionRange(b.inicio, b.fin);
}

// ponytail: foco al input de monto (select-all al abrir corrección, caret al final si no).
function enfocarMonto(id: number, seleccionar = false): void {
  const input = cellById(id)?.querySelector<HTMLInputElement>("input.cell-monto");
  if (!input) return;
  input.focus();
  if (seleccionar) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

/** cents → texto editable con redondez exacta por parsearMonto ("500" → "500.00"). */
function textoEditable(cents: Cents): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Valida y guarda el input (change o Enter). Id del comprobante o null si no hubo monto. */
function commitearMonto(input: HTMLInputElement, reenfocar = false): number | null {
  const cell = input.closest(".cell");
  const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
  const item = obtenerComprobante(id);
  if (!item) return null;
  const cents = parsearMonto(input.value);
  // Inválido → se conserva el borrador para corregirlo (el title muestra el formato).
  // ponytail: el blur (change) no roba el foco: solo Enter reenfoca.
  if (cents === null) {
    // Error visible solo con texto escrito (borrar = salir, no error).
    if (input.value.trim() !== "") {
      avisarError("Formato no válido: usa 1234.56");
      // La marca viaja con el borrador (restaurarBorrador/restaurarSucios):
      // el parche post-render se pierde cuando la VT difiere el swap.
      input.classList.add("monto-error");
      input.setAttribute("aria-invalid", "true");
    }
    renderHojas();
    if (reenfocar) enfocarMonto(id);
    return null;
  }
  // change en text input = escribió + blur/enter: el total pasa a manual.
  // ponytail: abrir y salir sin cambios también lo vuelve manual (queda
  // protegido de futuros auto-rellenos: el usuario lo validó).
  editandoMonto = null;
  item.montoCents = cents;
  item.montoManual = true;
  renderHojas();
  return id;
}

/** ¿La celda es apta para repintar el badge? (modo, nodo, ítem y monto). */
function celdaRepintable(id: number): boolean {
  if (state.modoOcr) return false; // en modo OCR la celda no lleva badge
  const cell = cellById(id);
  if (!cell) return false;
  const item = obtenerComprobante(id);
  return !!item && item.montoCents != null && item.id !== editandoMonto;
}

/** ¿El parche no pisaría una edición? (foco en el input o borrador sin foco). */
function celdaSinEdicion(cell: HTMLElement): boolean {
  const activo = document.activeElement;
  if (activo instanceof HTMLInputElement && cell.contains(activo)) return false; // edición en curso: no pisar
  const borrador = cell.querySelector("input.cell-monto");
  return !(borrador instanceof HTMLInputElement && borrador.value !== ""); // borrador sin foco: no pisar
}

// Repinta SOLO el monto de una celda (tick del re-chequeo) sin reconstruir la
// grilla ni tocar la imagen: O(1 nodo) en vez de O(N imágenes + snapshot VT).
// Nunca lanza (best-effort): false = lo cubre el render completo del final.
export function actualizarMontoCelda(id: number): boolean {
  if (!celdaRepintable(id)) return false;
  const cell = cellById(id) as HTMLElement; // celdaRepintable garantiza el nodo
  if (!celdaSinEdicion(cell)) return false;
  const item = obtenerComprobante(id) as Comprobante; // garantizado arriba
  const viejo = cell.querySelector(".cell-badge, input.cell-monto");
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "cell-badge";
  badge.dataset["accion"] = "corregir-monto";
  badge.title = "Total (clic para corregir)";
  // ponytail: montoCents != null garantizado por celdaRepintable (guard original).
  badge.textContent = formatearMoneda(item.montoCents as Cents);
  bajoMutandoHojas(() => {
    if (viejo) viejo.replaceWith(badge);
    else cell.append(badge);
  });
  renderMonto(); // total general con suma local exacta
  return true;
}

/* ---------- Drag entre casillas (Pointer Events: mover/swap) ---------- */

interface DragState {
  id: number;
  ghost: HTMLElement | null;
  gw: number;
  gh: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  activo: boolean;
}

let pointerDrag: DragState | null = null;
let scrollRaf: number | null = null;
let scrollDir = 0; // dirección vigente del loop; autoScroll la actualiza
let moveRaf: number | null = null;
let celdaResaltada: HTMLElement | null = null;
let rectsCache: Map<Element, DOMRect> | null = null;
let renderPendiente = false;

// ponytail: zoom de vista efímero (no persiste); es layout (zoom), no transform:
// así el scrollHeight acompaña y no hay zonas negativas inalcanzables. El pan es el scroll nativo.
let zoomEscala = 1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

function aplicarZoom(): void {
  rectsCache = null;
  if (zoomEscala === 1) sheetsEl.style.removeProperty("zoom");
  else sheetsEl.style.setProperty("zoom", String(zoomEscala));
  btnZoom.hidden = zoomEscala === 1;
  if (!btnZoom.hidden) btnZoom.textContent = `${Math.round(zoomEscala * 100)}%`;
}

function zoomEn(clientX: number, clientY: number, factor: number): void {
  const nueva = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomEscala * factor));
  if (nueva === zoomEscala) return;
  // Punto bajo el puntero antes del cambio; tras el zoom ese punto está a
  // dx*k del borde: se compensa con scroll (siempre dentro de [0, max]).
  const stage = sheetsEl.getBoundingClientRect();
  const dx = clientX - stage.left;
  const dy = clientY - stage.top;
  const k = nueva / zoomEscala;
  zoomEscala = nueva;
  aplicarZoom();
  canvasEl?.scrollBy?.(dx * (k - 1), dy * (k - 1));
}

// Zoom centrado en el wrapper (botones y atajos de teclado).
function zoomCentrado(factor: number): void {
  const base = (canvasEl ?? sheetsEl).getBoundingClientRect();
  zoomEn(base.left + base.width / 2, base.top + base.height / 2, factor);
}

// ponytail: lupa sobre la imagen de la grilla (sincrónica y exacta;
// full-res bajo demanda cuando el blur a 2.5x lo justifique). Estado efímero.
const LUPA_L = 200;
const LUPA_ZOOM = 2.5;
let lupaActiva = false;
let lupaRaf: number | null = null;
let lupaX = 0;
let lupaY = 0;
let lupaTieneMuestra = false;
let lupaSuprimirClic = false;

function setLupa(v: boolean): void {
  lupaActiva = v;
  btnLupa.setAttribute("aria-pressed", String(v));
  // ponytail: la lente reemplaza al puntero (centrada): sin cursor nativo.
  document.body.classList.toggle("lupa-activa", v);
  // ponytail: oculta hasta la primera muestra (activar con el puntero fuera
  // no debe plantar un cuadrado vacío en la esquina).
  lupaTieneMuestra = false;
  lupaEl.style.opacity = "0";
  lupaEl.style.contentVisibility = v ? "visible" : "hidden";
  if (v) {
    const dpr = window.devicePixelRatio || 1;
    lupaCanvas.width = LUPA_L * dpr;
    lupaCanvas.height = LUPA_L * dpr;
    lupaCanvas.style.width = `${LUPA_L}px`;
    lupaCanvas.style.height = `${LUPA_L}px`;
    lupaCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  } else {
    if (lupaRaf !== null) {
      cancelAnimationFrame(lupaRaf);
      lupaRaf = null;
    }
    lupaCtx?.clearRect(0, 0, LUPA_L, LUPA_L);
  }
}

/** Pinta la muestra de la imagen bajo el punto (false si no es foto útil). */
function intentarMuestraLupa(x: number, y: number, ctx: CanvasRenderingContext2D): boolean {
  const img = document.elementFromPoint(x, y)?.closest?.(".cell")?.querySelector("img");
  if (img instanceof HTMLImageElement && img.naturalWidth >= 2) {
    // Mapeo exacto con object-fit:contain (bandas según el ratio).
    const r = img.getBoundingClientRect();
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    if (s > 0) {
      const lado = Math.min(LUPA_L / LUPA_ZOOM / s, img.naturalWidth, img.naturalHeight);
      if (lado >= 1) {
        const bx = (x - (r.left + (r.width - img.naturalWidth * s) / 2)) / s;
        const by = (y - (r.top + (r.height - img.naturalHeight * s) / 2)) / s;
        const sx = Math.min(Math.max(bx - lado / 2, 0), Math.max(img.naturalWidth - lado, 0));
        const sy = Math.min(Math.max(by - lado / 2, 0), Math.max(img.naturalHeight - lado, 0));
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, sx, sy, lado, lado, 0, 0, LUPA_L, LUPA_L);
        return true;
      }
    }
  }
  return false;
}

function dibujarLupa(): void {
  lupaRaf = null;
  if (!lupaActiva || !lupaTieneMuestra) return;
  // Solo transform/opacity: el cuadrado reemplaza al puntero (centrado), sin layout.
  const pad = 16;
  const centra = (p: number, max: number): number =>
    Math.min(Math.max(pad, p - LUPA_L / 2), Math.max(pad, max - LUPA_L - pad));
  lupaEl.style.transform = `translate(${centra(lupaX, window.innerWidth)}px, ${centra(lupaY, window.innerHeight)}px)`;
  const ctx = lupaCtx;
  if (!ctx) return;
  ctx.clearRect(0, 0, LUPA_L, LUPA_L);
  if (intentarMuestraLupa(lupaX, lupaY, ctx)) return;
  // Fuera de foto: la lente amplía el fondo plano bajo el puntero (mesa, panel…).
  ctx.fillStyle = fondoBajoPunto(lupaX, lupaY);
  ctx.fillRect(0, 0, LUPA_L, LUPA_L);
}

// Primer fondo opaco bajo el punto (areas planas ampliadas = color plano).
function fondoBajoPunto(x: number, y: number): string {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg)) return bg;
    el = el.parentElement;
  }
  return "#000";
}

function detenerScroll(): void {
  scrollDir = 0;
  if (scrollRaf !== null) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
  }
}

function cancelarDragVisual(): void {
  sheetsEl.querySelectorAll(".drop-target").forEach((c) => c.classList.remove("drop-target"));
  sheetsEl.querySelectorAll(".sheet-grid.dragging").forEach((g) => g.classList.remove("dragging"));
  sheetsEl.querySelectorAll(".sheet.file-drop").forEach((s) => s.classList.remove("file-drop"));
  sheetsEl.querySelectorAll(".cell.pickup").forEach((c) => c.classList.remove("pickup"));
  document.querySelectorAll(".drag-ghost").forEach((g) => g.remove());
  document.body.classList.remove("is-dragging");
  celdaResaltada = null;
  rectsCache = null;
  if (moveRaf !== null) {
    cancelAnimationFrame(moveRaf);
    moveRaf = null;
  }
  detenerScroll();
  const sel = window.getSelection();
  if (sel?.rangeCount) sel.removeAllRanges();
}

function autoScroll(x: number, y: number): void {
  const r = canvasEl.getBoundingClientRect();
  const margen = 70,
    vel = 14;
  scrollDir = y < r.top + margen ? -vel : y > r.bottom - margen ? vel : 0;
  if (scrollDir && scrollRaf === null) {
    const paso = (): void => {
      // ponytail: paso solo corre con scrollDir ≠ 0 (detenerScroll cancela el
      // rAF pendiente) y scrollRaf ≠ null (solo se anula al cancelar este paso).
      canvasEl.scrollBy?.({ top: scrollDir }); // ?. : jsdom no implementa scrollBy; en Chrome siempre existe.
      scrollRaf = requestAnimationFrame(paso);
    };
    scrollRaf = requestAnimationFrame(paso);
  } else if (!scrollDir) {
    detenerScroll();
  }
}

export function esDragDeArchivos(e: DragEvent): boolean {
  return Iterator.from(e.dataTransfer?.types ?? []).some((t) => t === "Files");
}

// Rects cacheados durante el drag: getBoundingClientRect 1 vez por layout real.
function celdaRect(c: Element): DOMRect {
  if (!rectsCache) {
    rectsCache = new Map();
    for (const el of sheetsEl.querySelectorAll(".cell"))
      rectsCache.set(el, el.getBoundingClientRect());
  }
  let r = rectsCache.get(c);
  if (!r) {
    r = c.getBoundingClientRect();
    rectsCache.set(c, r);
  }
  return r;
}

/** La celda más cercana a (x, y) del listado (el cap de 150 queda en el llamador). */
function masCercanaEntre(celulas: Element[], x: number, y: number): HTMLElement | null {
  let mejor: HTMLElement | null = null;
  let mejorD = Infinity;
  for (const c of celulas) {
    const r = celdaRect(c);
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < mejorD && c instanceof HTMLElement) {
      mejorD = d;
      mejor = c;
    }
  }
  return mejorD < 150 ? mejor : null;
}

function celdaBajoPunto(x: number, y: number, excluir: Element | null): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  const directa = el?.closest?.(".cell");
  if (directa instanceof HTMLElement && !directa.closest(".sheet-fantasma")) return directa;
  const hoja = el?.closest?.(".sheet");
  const scope: ParentNode = hoja ?? sheetsEl;
  // El fantasma no es destino de drag (clic-sí / drag-no): se excluye del
  // barrido para no prometer un drop que sería no-op.
  const celulas = [...scope.querySelectorAll(".cell")].filter(
    (c) => c !== excluir && !c.closest(".sheet-fantasma"),
  );
  return masCercanaEntre(celulas, x, y);
}

function iniciarGhost(d: DragState, x: number, y: number): void {
  if (d.ghost) return;
  const celdaOrigen = cellById(d.id);
  if (!celdaOrigen) return;
  // Sin <img> (celda vacía): fantasma desde la caja para no
  // dejar el drag muerto en lotes grandes.
  const img = celdaOrigen.querySelector("img");
  const fuente = img ?? celdaOrigen;
  const base = fuente.getBoundingClientRect();
  if (base.width < 2) return;
  const ghost = fuente.cloneNode(img !== null) as HTMLElement;
  ghost.className = "drag-ghost";
  ghost.style.width = `${base.width}px`;
  ghost.style.height = `${base.height}px`;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.gw = base.width / 2;
  d.gh = base.height / 2;
  d.activo = true;
  celdaOrigen.classList.add("pickup");
  document.body.classList.add("is-dragging");
  posicionarGhost(d, x, y);
}

// El ghost se mueve solo con transform (compositor): cero lecturas de layout.
function posicionarGhost(d: DragState, x: number, y: number): void {
  d.ghost?.style.setProperty(
    "transform",
    `translate(${x - d.gw}px, ${y - d.gh}px) rotate(1.5deg) scale(1.04)`,
  );
}

function resaltarDestino(cell: HTMLElement | null): void {
  if (cell && cell.dataset["id"] === String(pointerDrag?.id)) cell = null;
  if (cell === celdaResaltada) return;
  celdaResaltada?.classList.remove("drop-target");
  celdaResaltada = null;
  if (cell && sheetsEl.contains(cell)) {
    cell.classList.add("drop-target");
    celdaResaltada = cell;
  }
}

// FLIP "Play": vuela `img` desde un centro aparente hasta su posición real.
function animarFlipDesde(img: HTMLImageElement, cx: number, cy: number): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = img.getBoundingClientRect();
  if (r.width < 2) return;
  const dx = cx - (r.left + r.width / 2);
  const dy = cy - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < 2) return;
  void img.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: 170, easing: "cubic-bezier(.2, .8, .2, 1)" },
  );
}

function actualizarConteoPanel(hoja: Hoja): void {
  const span = sheetsEl.querySelector(`.sheet-row[data-hoja="${hoja.id}"] .sheet-panel-count`);
  if (span) span.textContent = `${cuentaHoja(hoja)}/${layoutDe(hoja.layout).total}`;
}

/** Nodo de una celda de la grilla por (hoja, slot). */
function nodoCeldaHoja(hojaId: number, slot: number): HTMLElement | null {
  return sheetsEl.querySelector<HTMLElement>(
    `.sheet[data-hoja="${hojaId}"] .cell[data-slot="${slot}"]`,
  );
}

/** La imagen del comprobante que hoy ocupa el slot destino (para el FLIP). */
function imagenDelOcupante(ocupante: Comprobante | null): HTMLImageElement | null | undefined {
  return ocupante ? cellById(ocupante.id)?.querySelector("img") : undefined;
}

/** FLIP doble tras el parche: entra el destino y regresa el que salió. */
function animarDobleFlip(
  nodoDestino: HTMLElement,
  nodoOrigen: HTMLElement,
  centroA: { x: number; y: number },
  rB: DOMRect | undefined,
): void {
  const imgA = nodoDestino.querySelector("img");
  if (imgA) animarFlipDesde(imgA, centroA.x, centroA.y);
  const imgBDestino = nodoOrigen.querySelector("img");
  if (imgBDestino && rB)
    animarFlipDesde(imgBDestino, rB.left + rB.width / 2, rB.top + rB.height / 2);
}

/** Conteos del panel tras el swap (dos hojas si cruzaron de hoja). */
function refrescarConteos(origen: Hoja, hojaDestino: Hoja): void {
  actualizarConteoPanel(origen);
  if (hojaDestino !== origen) actualizarConteoPanel(hojaDestino);
}

// Mueve (o intercambia) al slot pedido repintando solo 2 casillas + FLIP.
function moverSlot(
  drag: { id: number },
  hojaDestino: Hoja,
  slotDestino: number,
  centroA: { x: number; y: number },
): void {
  const actual = buscarSlot(drag.id);
  if (!actual) return;
  const { hoja: origen, idx: idxOrigen } = actual;
  if (origen === hojaDestino && idxOrigen === slotDestino) return;

  // ponytail: slots es array denso (celdas materializadas a null), sin undefined.
  const ocupante = hojaDestino.slots[slotDestino] as Comprobante | null;
  const imgOcupante = imagenDelOcupante(ocupante);
  const rB = imgOcupante?.getBoundingClientRect();

  const idsHojasAntes = state.hojas.map((h) => h.id).join();
  const reemplazo = hojaDestino.slots[slotDestino] as Comprobante | null;
  const movida = origen.slots[idxOrigen] as Comprobante | null;
  hojaDestino.slots[slotDestino] = movida;
  origen.slots[idxOrigen] = reemplazo;
  limpiarHojas();

  const estructural = state.hojas.map((h) => h.id).join() !== idsHojasAntes;
  const nodoOrigen = nodoCeldaHoja(origen.id, idxOrigen);
  const nodoDestino = nodoCeldaHoja(hojaDestino.id, slotDestino);
  if (estructural || !nodoOrigen || !nodoDestino) {
    renderHojas();
    return;
  }

  // ponytail: el parche de 2 celdas también destruye inputs con foco.
  bajoMutandoHojas(() => {
    pintarCelda(nodoOrigen, origen.slots[idxOrigen] as Comprobante | null, idxOrigen, origen.id);
    pintarCelda(
      nodoDestino,
      hojaDestino.slots[slotDestino] as Comprobante | null,
      slotDestino,
      hojaDestino.id,
    );
  });

  animarDobleFlip(nodoDestino, nodoOrigen, centroA, rB);
  refrescarConteos(origen, hojaDestino);
  renderMonto();
}

/** Centro de una celda (la "soltura" del FLIP cuando mueve el teclado). */
function centroDeCelda(cell: HTMLElement): { x: number; y: number } {
  const r = cell.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Si un hueco existe en la hoja: índice; si está llena, null. */
function primerHueco(h: Hoja): number | null {
  const hueco = h.slots.indexOf(null);
  return hueco < 0 ? null : hueco;
}

/** Vecino lineal del lote (hoja + slot), cruzando el borde de la hoja si toca;
    null en el borde del lote (no hay vecino). */
function vecinoLineal(
  hoja: Hoja,
  slot: number,
  avanza: boolean,
): { hoja: Hoja; slot: number } | null {
  const destino = slot + (avanza ? 1 : -1);
  if (destino >= 0 && destino < hoja.slots.length) return { hoja, slot: destino };
  const otra = state.hojas[state.hojas.indexOf(hoja) + (avanza ? 1 : -1)];
  return otra ? { hoja: otra, slot: avanza ? 0 : otra.slots.length - 1 } : null;
}

/** Reorden por teclado (2.5.7): Ctrl/Alt+flecha mueve la celda (convive con el
    drag: ambos entran por moverSlot). ←/→ son el vecino lineal del lote;
    ↑/↓ cambian de hoja conservando el slot, con caída al primer hueco si la
    fila destino es más corta. El re-enfoque sigue el patrón escaparMonto. */
function cablearReordenTeclado(): void {
  sheetsEl.addEventListener("keydown", (e) => {
    if (state.modoOcr || pointerDrag) return; // mismo bloqueo que el drag manual
    if (esCampoTexto(e.target)) return; // las flechas editan texto (no mover)
    const cell = e.target instanceof Element ? e.target.closest(".cell") : null;
    if (!(cell instanceof HTMLElement) || !cell.dataset["id"]) return;
    // El alias del Ctrl solo es horizontal (lo aprobado): Alt+vertical no actúa.
    const conMod =
      (e.ctrlKey || (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) &&
      !e.metaKey &&
      !e.shiftKey;
    if (!conMod || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const id = Number(cell.dataset["id"]);
    const actual = buscarSlot(id);
    if (!actual) return;

    let destino: { hoja: Hoja; slot: number };
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const vecino = vecinoLineal(actual.hoja, actual.idx, e.key === "ArrowRight");
      if (!vecino) return; // borde del lote: no hay vecino
      destino = vecino;
    } else {
      const otra = state.hojas[state.hojas.indexOf(actual.hoja) + (e.key === "ArrowDown" ? 1 : -1)];
      // ponytail: hoja inexistente (borde del lote) u hoja llena sin hueco:
      // silencio — la flecha se repite rápido y un #aviso sería ruido.
      if (!otra) return;
      const slot = actual.idx < otra.slots.length ? actual.idx : primerHueco(otra);
      if (slot === null) return;
      destino = { hoja: otra, slot };
    }
    moverSlot({ id }, destino.hoja, destino.slot, centroDeCelda(cell));
    // El render pudo reconstruir la grilla (hoja vaciada): nodo fresco.
    (nodoCeldaHoja(destino.hoja.id, destino.slot) as HTMLElement | null)?.focus();
  });
}

// Único camino de cierre del drag (pointerup + red de lostpointercapture).
function finalizarDrag(x: number, y: number): void {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  const fueActivo = drag.activo;
  const celdaOrigen = cellById(drag.id);
  pointerDrag = null;
  cancelarDragVisual();
  soltarRenderPendiente();
  if (!fueActivo) return;
  const cell = celdaBajoPunto(x, y, celdaOrigen);
  if (!cell?.closest) return;
  const hojaDestino = hojaPorId(cell.closest(".sheet")?.getAttribute("data-hoja") ?? "");
  const slotDestino = Number(cell.dataset["slot"]);
  if (!hojaDestino || !Number.isInteger(slotDestino)) return;
  moverSlot(drag, hojaDestino, slotDestino, { x, y });
}

export interface SheetsCallbacks {
  agregarArchivos: (files: FileList | File[] | null | undefined, hojaId?: number | null) => void;
  pedirArchivos: (hojaId: number) => void;
  /** Clic en celda vacía: pega el portapapeles en ese slot exacto. */
  pegarEnCelda?: (hojaId: number, slotIdx: number) => Promise<void> | void;
}

/** Id de la hoja fantasma (solo visual, nunca en state.hojas): los ids reales son ≥1.
    Clic-sí / drag-no (el drag la ignora); el drop la normaliza a null en el borde. */
export const HOJA_FANTASMA: number = -1;

// ponytail: callbacks vigentes (initSheets los refresca aunque los listeners ya
// existan: HMR/tests re-cablean sin duplicar).
let callbacks: SheetsCallbacks | null = null;

// ponytail: swap destructivo en curso (un change que llegue ahora es eco de
// remoción, no edición del usuario: se ignora en el handler change).
let mutandoHojas = false;

/** Corre una mutación destructiva del DOM bajo el flag anti-eco. */
function bajoMutandoHojas(fn: () => void): void {
  mutandoHojas = true;
  try {
    fn();
  } finally {
    mutandoHojas = false;
  }
}

/** Predicado del guard anti-eco (exportado para regresionarlo en tests). */
export function esEcoDeRemocion(target: HTMLInputElement): boolean {
  return mutandoHojas || !target.isConnected;
}

/** Celda elegible para el arrastre manual (null en botones ligados, vacías y OCR). */
function celulaArrastrable(e: PointerEvent): HTMLElement | null {
  if (e.button !== 0 || !e.isPrimary) return null;
  if (state.modoOcr) return null;
  if (!(e.target instanceof Element)) return null;
  const cell = e.target.closest(".cell");
  if (!(cell instanceof HTMLElement) || cell.classList.contains("empty")) return null;
  if (
    e.target.closest(
      '[data-accion="quitar"],[data-accion="girar-izq"],[data-accion="girar-der"],[data-accion="recortar"],[data-accion="monto"],[data-accion="corregir-monto"]',
    )
  )
    return null;
  return cell;
}

/** ARRSTRE manual: pointerdown toma la celda y captura el puntero. */
function cablearArrastreIniciar(): void {
  sheetsEl.addEventListener("pointerdown", (e) => {
    const cell = celulaArrastrable(e);
    if (!cell) return;
    e.preventDefault();
    if (pointerDrag) {
      pointerDrag = null;
      cancelarDragVisual();
    }
    pointerDrag = {
      id: Number(cell.dataset["id"]),
      ghost: null,
      gw: 0,
      gh: 0,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      activo: false,
    };
    cell.closest(".sheet-grid")?.classList.add("dragging");
    try {
      sheetsEl.setPointerCapture(e.pointerId);
    } catch {
      /* puntero ya inactivo */
    }
  });
}

/** ARRSTRE: pointermove activa el ghost a >5px y redibuja con rAF. */
function cablearArrastreMover(): void {
  document.addEventListener("pointermove", (e) => {
    if (!pointerDrag) return;
    const drag: DragState = pointerDrag;
    if (!drag.activo) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= 5) return;
      iniciarGhost(drag, e.clientX, e.clientY);
      if (!drag.activo) return;
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    posicionarGhost(drag, e.clientX, e.clientY);
    if (moveRaf !== null) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = null;
      const d = pointerDrag;
      if (!d) return;
      autoScroll(d.lastX, d.lastY);
      resaltarDestino(celdaBajoPunto(d.lastX, d.lastY, cellById(d.id)));
    });
  });
}

/** Único camino de cierre del drag (pointerup + red de lostpointercapture). */
function cablearArrastreCierre(): void {
  document.addEventListener("pointerup", (e) => finalizarDrag(e.clientX, e.clientY));
  sheetsEl.addEventListener("lostpointercapture", (e) => {
    if (!e.isPrimary || !pointerDrag) return;
    finalizarDrag(pointerDrag.lastX, pointerDrag.lastY);
  });
  document.addEventListener("pointercancel", () => {
    if (!pointerDrag) return;
    pointerDrag = null;
    cancelarDragVisual();
    soltarRenderPendiente();
  });
}

/** ¿El evento es la tecla M limpia de modificadores (toggle de la lupa)? */
function esPresionM(e: KeyboardEvent): boolean {
  return (e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** ¿El destino es un campo de texto? (la M no debe alternar la lupa ahí). */
function esCampoTexto(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement ||
      t.isContentEditable)
  );
}

function togglarLupaConM(e: KeyboardEvent): void {
  if (!esPresionM(e)) return;
  if (esCampoTexto(e.target)) return;
  setLupa(!lupaActiva);
}

/** ¿El atajo de teclado es de zoom (ctrl/meta + tecla)? */
function esAtajoZoom(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key);
}

function aplicarAtajoZoom(e: KeyboardEvent): void {
  if (!esAtajoZoom(e)) return;
  e.preventDefault();
  if (e.key === "0") {
    zoomEscala = 1;
    aplicarZoom();
    return;
  }
  zoomCentrado(e.key === "+" || e.key === "=" ? 1.2 : 1 / 1.2);
}

function cablearTeclasGlobales(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pointerDrag) {
      pointerDrag = null;
      cancelarDragVisual();
      soltarRenderPendiente();
    }
    if (e.key === "Escape" && lupaActiva) {
      setLupa(false);
      return;
    }
    // ponytail: M alterna la lupa, salvo escribiendo (montos/código) o con Ctrl.
    togglarLupaConM(e);
    // ponytail: atajos mínimos para no dejar el zoom solo al puntero (a11y teclado).
    aplicarAtajoZoom(e);
  });
}

/** Anuncia el éxito del copiado: check del botón + live region + timer. */
function anunciarCopiado(btn: HTMLElement): void {
  const previo = copiadoTimers.get(btn);
  if (previo !== undefined) window.clearTimeout(previo);
  btn.classList.add("copiado");
  btn.title = "Copiar OCR";
  btn.setAttribute("aria-label", "Copiado");
  const anuncio = document.getElementById("estadoCopiado");
  if (anuncio) anuncio.textContent = "Copiado";
  copiadoTimers.set(
    btn,
    window.setTimeout(() => {
      if (!btn.isConnected) return;
      btn.classList.remove("copiado");
      btn.setAttribute("aria-label", "Copiar OCR");
      const aviso = document.getElementById("estadoCopiado");
      if (aviso) aviso.textContent = "";
    }, TIEMPO_COPIADO_MS),
  );
}

/** Revierte el check del botón (writeText rechazado). */
function deshacerCopiado(btn: HTMLElement, fallo: string): void {
  const previo = copiadoTimers.get(btn);
  if (previo !== undefined) {
    window.clearTimeout(previo);
    copiadoTimers.delete(btn);
  }
  btn.classList.remove("copiado");
  btn.setAttribute("aria-label", "Copiar OCR");
  btn.title = fallo;
}

/** Acción `copiar-ocr`: al portapapeles con check temporal en el botón. */
function copiarOcrAlPortapapeles(id: number, btn: HTMLElement): void {
  const item = obtenerComprobante(id);
  if (!item || !item.textoOcr) return;
  // Sin Promise.try (ausente en Node 22 del CI): writeText ya devuelve promesa.
  // clipboard no existe fuera de contexto seguro (http): TypeError antes de la promesa.
  // El fallo avisa en el toast rojo de #aviso y también queda en el title del botón.
  const fallo = "Copiar falló (sin permiso del portapapeles)";
  const portapapeles = navigator.clipboard;
  if (typeof portapapeles?.writeText !== "function") {
    avisarError("No se pudo copiar el texto: dale permiso al portapapeles e intentá de nuevo.");
    btn.title = fallo;
    return;
  }
  void portapapeles
    .writeText(item.textoOcr)
    .then(() => anunciarCopiado(btn))
    .catch(() => {
      avisarError("No se pudo copiar el texto: dale permiso al portapapeles e intentá de nuevo.");
      deshacerCopiado(btn, fallo);
    });
}

/** Acción `corregir-monto`: abre la edición no destructiva del total. */
function abrirCorreccionMonto(id: number): void {
  const item = obtenerComprobante(id);
  // ponytail: apertura no destructiva (el valor previo se edita, no se
  // borra); fuera de ok no hay input que mostrar. Sin recálculo: solo
  // entra por subida/botón/giro.
  if (!item || item.estado !== "ok") return;
  editandoMonto = id;
  renderHojas();
  enfocarMonto(id, true);
}

/** Acción `recortar` con la ventana anti-clic tras el descarte (import dinámico). */
function abrirRecorteSiHaceFalta(id: number): void {
  // ponytail: solo recortar se suprime tras el descarte (carrera
  // descarte→clic en la celda de abajo); el resto acciona siempre.
  if (Date.now() - state.cierreRecorte < VENTANA_CIERRE_RECORTE_MS) return;
  // ponytail: dinámico (recorte importa la cola: estático sería ciclo). Único
  // chunk lazy real: tras un deploy el asset hashado viejo 404ea y el click
  // moriría callado; avisa por el canal del pipeline (si es chunk muerto,
  // sale el "recargá el navegador").
  void import("./recorte")
    .then((m) => m.abrirRecorte(id))
    .catch((e: unknown) => falloIa(e, "recorte"));
}

/** Acción `agregar`: pedir archivos para la hoja del botón. */
function pedirAgregar(btn: HTMLElement): void {
  // El fantasma no tiene botón ＋ (su columna va vacía): -1 nunca llega acá.
  const destino = Number(btn.dataset["hoja"]);
  if (Number.isInteger(destino)) callbacks?.pedirArchivos(destino);
}

/** Acción `pegar` en celda vacía: lock por botón (read() async) + callback. */
function pegarDesdeBoton(btn: HTMLElement): void {
  // En modo OCR el pegado por clic está bloqueado (como el reordenamiento).
  if (state.modoOcr) return;
  if (!(btn instanceof HTMLButtonElement)) return;
  // ponytail: lock por botón (el read() es async: sin esto el doble-clic pega dos veces).
  if (btn.dataset["pegando"] === "1") return;
  // ponytail: dataset SIEMPRE gravado por pintarCelda en .cell-pegar; el fallback
  // por dataset de la celda era rama muerta (el guard NaN cubre el faltante raro).
  const hoja = Number(btn.dataset["hoja"]);
  const slot = Number(btn.dataset["slot"]);
  if (!Number.isInteger(hoja) || !Number.isInteger(slot)) return;
  const listo = callbacks?.pegarEnCelda?.(hoja, slot);
  if (listo instanceof Promise) {
    btn.dataset["pegando"] = "1";
    void listo.finally(() => {
      delete btn.dataset["pegando"];
    });
  }
}

/**
 * Dispatcher del clic delegado: `data-accion` → handler (tabla en vez de
 * switch: cada botón tiene una sola acción y ningún case corta la propagación).
 * Los cuerpos de cada acción viven en las helpers de arriba.
 */
const ACCIONES_CLIC: Readonly<Record<string, (btn: HTMLElement, id: number) => void>> = {
  "copiar-ocr": (btn, id) => copiarOcrAlPortapapeles(id, btn),
  quitar: (_btn, id) => quitarComprobante(id),
  "girar-izq": (_btn, id) => void girarYReleer(id, 270),
  "girar-der": (_btn, id) => void girarYReleer(id, 90),
  recortar: (_btn, id) => abrirRecorteSiHaceFalta(id),
  "corregir-monto": (_btn, id) => abrirCorreccionMonto(id),
  layout: (btn) => cambiarLayoutHoja(btn.dataset["hoja"] ?? "", btn.dataset["layout"] ?? ""),
  "apply-all": (btn) => aplicarATodas(btn.dataset["hoja"] ?? ""),
  agregar: (btn) => pedirAgregar(btn),
  pegar: (btn) => pegarDesdeBoton(btn),
};

function cablearAcciones(): void {
  // Evento delegado: un solo listener, dispatch por data-accion.
  sheetsEl.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest("[data-accion]");
    if (!(btn instanceof HTMLElement)) return;
    const cell = btn.closest(".cell");
    const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
    // ponytail: el selector garantiza data-accion presente; una acción fuera de
    // la tabla no existe hoy (el lookup undefined es guard, no flujo).
    const fn = ACCIONES_CLIC[btn.dataset["accion"] as string];
    if (fn) fn(btn, id);
  });
}

/** Monto manual: un solo change delegado (el render reconstruye la grilla). */
function cablearMontoCambio(): void {
  sheetsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement) || target.dataset["accion"] !== "monto") return;
    // ponytail: eco de remoción (el swap destruyó el input enfocado): nunca es edición.
    if (esEcoDeRemocion(target)) return;
    commitearMonto(target);
  });
}

/** Escape en el monto: baja el drag (no difirir el render) y descarta el borrador. */
function escaparMonto(e: KeyboardEvent, id: number): void {
  e.preventDefault();
  // ponytail: cancelar es no tocar el estado (sigue el valor previo) y el
  // flag fresco cubre el input sin valor previo; sin change en el camino.
  // ponytail: primero se baja el drag (este handler corre antes que el de
  // document): con drag activo el render se difiere y el foco a la celda
  // commitearía el borrador vía change.
  if (pointerDrag) {
    pointerDrag = null;
    cancelarDragVisual();
    renderPendiente = false;
  }
  editandoMonto = null;
  descartarBorrador = true;
  try {
    renderHojas(); // descarta el borrador sin disparar change
  } finally {
    descartarBorrador = false;
  }
  // ponytail: el input vive dentro de su celda (verificado al entrar al handler).
  (cellById(id) as HTMLElement).focus();
}

/** Monto manual por teclado: Enter confirma, Escape cancela el borrador. */
function cablearMontoTeclado(): void {
  sheetsEl.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement) || target.dataset["accion"] !== "monto") return;
    const cell = target.closest(".cell");
    const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
    if (!Number.isInteger(id)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      // ponytail: commit directo (sin blur): el foco sigue en el input y el
      // render sale síncrono, así el badge ya existe al enfocarlo. El commit
      // exitoso garantiza celda y badge (pintarBadgeOMonto los pinta juntos).
      const confirmado = commitearMonto(target, true);
      if (confirmado !== null) {
        (cellById(confirmado) as HTMLElement).querySelector<HTMLElement>(".cell-badge")?.focus();
      }
      return;
    }
    if (e.key === "Escape") escaparMonto(e, id);
  });
}

/** Drag nativo de archivos del explorador (DataTransfer) al pasar sobre las hojas. */
function cablearArchivosEntrada(): void {
  // La entrada nunca se bloquea por el modo OCR (solo el reordenamiento).
  sheetsEl.addEventListener("dragover", (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    autoScroll(e.clientX, e.clientY);
    const target = e.target as HTMLElement | null;
    const sheet = target?.closest?.(".sheet");
    sheetsEl.querySelectorAll(".sheet.file-drop").forEach((s) => {
      if (s !== sheet) s.classList.remove("file-drop");
    });
    if (sheet instanceof HTMLElement && sheet.dataset["hoja"] !== String(HOJA_FANTASMA))
      sheet.classList.add("file-drop");
  });
}

/** Al salir del drag de archivos: limpia el highlight y para el auto-scroll. */
function cablearArchivosFuera(): void {
  sheetsEl.addEventListener("dragleave", (e) => {
    if (!esDragDeArchivos(e)) return;
    const target = e.target as HTMLElement | null;
    const related = e.relatedTarget as Node | null;
    const sheet = target?.closest?.(".sheet");
    if (sheet instanceof HTMLElement && !sheet.contains(related)) {
      sheet.classList.remove("file-drop");
      detenerScroll(); // el arrastre salió: sin esto el loop rAF seguía scrolleando.
    }
  });
}

/** Drop de archivos: el fantasma va por el flujo normal (su crudo es -1 → null). */
function cablearArchivosSoltar(): void {
  sheetsEl.addEventListener("drop", (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    if (!(e.target instanceof Element)) return; // drop no-Elemento: nada que hacer (mismo guard que cablearAcciones)
    const sheet = e.target.closest(".sheet");
    cancelarDragVisual();
    if (sheet instanceof HTMLElement) {
      const crudo = Number(sheet.dataset["hoja"]);
      // ponytail: dataTransfer no-null garantizado por esDrag (types incluyó Files).
      callbacks?.agregarArchivos(
        (e.dataTransfer as DataTransfer).files,
        crudo === HOJA_FANTASMA ? null : crudo,
      );
    }
  });
}

/** Zoom: el scroll invalida los rects cacheados; rueda con ctrl y 3 botones. */
function cablearZoom(): void {
  canvasEl?.addEventListener(
    "scroll",
    () => {
      rectsCache = null;
    },
    { passive: true },
  );

  // ponytail: ctrl+rueda = zoom solo canvas (sin ctrl el scroll sigue nativo).
  (canvasEl ?? sheetsEl).addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaMode === 0 ? e.deltaY : e.deltaY * 16;
      zoomEn(e.clientX, e.clientY, Math.exp(-delta * 0.0015));
    },
    { passive: false },
  );

  btnZoom.addEventListener("click", () => {
    zoomEscala = 1;
    aplicarZoom();
  });

  btnZoomMas.addEventListener("click", () => zoomCentrado(1.2));
  btnZoomMenos.addEventListener("click", () => zoomCentrado(1 / 1.2));
}

/** La lupa se apaga con clic/tecla; el clic en vuelo del apagado se traga. */
function cablearLupaApagar(): void {
  btnLupa.addEventListener("click", () => setLupa(!lupaActiva));

  // ponytail: el primer press con la lupa apaga (y el clic en vuelo se traga:
  // no dispara la acción de abajo). El grupo zoom se excluye: coexiste con la lente.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!lupaActiva) {
        lupaSuprimirClic = false; // clic en vuelo que nunca llegó: no envenenar el próximo
        return;
      }
      if (!e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if ((e.target as HTMLElement | null)?.closest?.("#btnLupa, .zoom-grupo")) return;
      e.stopPropagation();
      setLupa(false);
      lupaSuprimirClic = true;
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (!lupaSuprimirClic) return;
      lupaSuprimirClic = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  // ponytail: el clic de teclado (Enter/Espacio) no lleva pointerdown previo:
  // si purgara por press, un flag rancio se lo tragaría. Los gestos
  // abortados tampoco dejan clic en vuelo.
  document.addEventListener(
    "keydown",
    () => {
      lupaSuprimirClic = false;
    },
    true,
  );
  document.addEventListener("pointercancel", () => {
    lupaSuprimirClic = false;
  });
}

/** Feed compartido de pointermove/enter: muestra la lente y agenda el rAF. */
function alimentarLupa(e: PointerEvent): void {
  if (!lupaActiva) return;
  lupaX = e.clientX;
  lupaY = e.clientY;
  lupaTieneMuestra = true;
  lupaEl.style.opacity = "1";
  if (lupaRaf === null) lupaRaf = requestAnimationFrame(dibujarLupa);
}

/** Lente viva sobre la zona de hojas (no consume wheel ni clics). */
function cablearLupaLente(): void {
  // ponytail: la lupa no consume wheel (el ctrl+rueda sigue al zoom) ni clics.
  const zonaLupa = canvasEl ?? sheetsEl;
  zonaLupa.addEventListener("pointermove", alimentarLupa);
  zonaLupa.addEventListener("pointerleave", () => {
    lupaTieneMuestra = false;
    lupaEl.style.opacity = "0";
  });
  zonaLupa.addEventListener("pointerenter", alimentarLupa);
}

export function initSheets(cb: SheetsCallbacks): void {
  callbacks = cb;
  // ponytail: guard anti doble-cableado (HMR/tests llaman más de una vez).
  // Todo el estado que los listeners comparten vive en el módulo, así que solo
  // se reparten en 13 cablear* (una por bloque) sin atravesar cierres.
  if (sheetsEl.dataset["init"] === "1") return;
  sheetsEl.dataset["init"] = "1";
  cablearArrastreIniciar();
  cablearArrastreMover();
  cablearArrastreCierre();
  cablearTeclasGlobales();
  cablearAcciones();
  cablearMontoCambio();
  cablearMontoTeclado();
  cablearReordenTeclado();
  cablearArchivosEntrada();
  cablearArchivosFuera();
  cablearArchivosSoltar();
  cablearZoom();
  cablearLupaApagar();
  cablearLupaLente();
}
