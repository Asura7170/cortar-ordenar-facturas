/* Hojas carta: render de casillas + drag & drop de comprobantes. */
import {
  buscarSlot,
  hojaPorId,
  limpiarHojas,
  obtenerComprobante,
  redistribuir,
  state,
} from "../state";
import type { Cents, Comprobante, Hoja, Plantilla } from "../types";
import { NOMBRES_LAYOUT, ORDEN_PLANTILLAS, PLANTILLAS, isLayoutId, layoutDe } from "./layout";
import { cuentaHoja, formatearMoneda, parsearMonto, renderMonto, totalItems } from "./monto";
import { girarYReleer } from "../pipeline/rotar";
import { getEl, sanear } from "../utils";

const sheetsEl: HTMLElement = getEl("sheets");
const metaHojas: HTMLElement = getEl("metaHojas");
const btnZoom: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoom");
const btnZoomMas: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoomMas");
const btnZoomMenos: HTMLButtonElement = getEl<HTMLButtonElement>("btnZoomMenos");
const btnLupa: HTMLButtonElement = getEl<HTMLButtonElement>("btnLupa");
const lupaEl: HTMLElement = getEl("lupa");
const lupaCanvas: HTMLCanvasElement = getEl<HTMLCanvasElement>("lupaCanvas");
const lupaCtx: CanvasRenderingContext2D | null = lupaCanvas.getContext("2d");
// Tarjeta de subida: visible solo con cero comprobantes.
const tarjetaVacia: HTMLElement = getEl("dropzone");
const canvasEl: HTMLElement | null = document.querySelector(".canvas");

/* ---------- Render de casillas (sin innerHTML para datos del usuario) ---------- */

function celda(
  item: Comprobante | null,
  pos: Plantilla["pos"][number] | undefined,
  slotIdx: number,
  hojaId: number,
): HTMLElement {
  const estilo = pos ? `grid-row: ${pos[0]}; grid-column: ${pos[1]} / span ${pos[2]};` : "";
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
    div.classList.add("empty");
    div.textContent = "Vacío";
    return;
  }

  div.dataset["id"] = String(item.id);

  if (state.modoOcr) {
    div.classList.add("cell-ocr");
    const pre = document.createElement("pre");
    pre.className = "cell-ocr-text";
    pre.textContent = sanear(
      item.textoOcr ||
        (item.estado === "procesando"
          ? "Procesando…"
          : item.estado === "pendiente"
            ? "(pendiente)"
            : "(sin texto OCR)"),
    );
    const btn = document.createElement("button");
    btn.className = "cell-remove";
    btn.dataset["accion"] = "copiar-ocr";
    btn.title = "Copiar OCR";
    btn.setAttribute("aria-label", "Copiar OCR");
    btn.textContent = "⧉";
    div.append(pre, btn);
    return;
  }

  div.classList.add(`cell-${item.estado}`);
  const btn = document.createElement("button");
  btn.className = "cell-remove";
  btn.dataset["accion"] = "quitar";
  btn.title = "Quitar";
  btn.setAttribute("aria-label", "Quitar comprobante");
  btn.textContent = "×";
  if (item.estado === "ok") {
    // Giro manual (fallback del auto-enderezado): arriba-izquierda, espejo del ×.
    for (const [accion, glifo, lado] of [
      ["girar-izq", "⟲", "izquierda"],
      ["girar-der", "⟳", "derecha"],
    ] as const) {
      const g = document.createElement("button");
      g.type = "button";
      g.className = `cell-girar cell-${accion}`;
      g.dataset["accion"] = accion;
      g.title = `Girar a la ${lado}`;
      g.setAttribute("aria-label", `Girar a la ${lado}`);
      g.textContent = glifo;
      div.append(g);
    }
  }
  if (item.thumbUrl) {
    const img = document.createElement("img");
    img.src = item.thumbUrl; // solo el thumb: el full-res nunca se decodifica en la grilla
    img.alt = sanear(item.nombre);
    img.draggable = false;
    img.loading = "lazy";
    img.decoding = "async";
    div.append(img, btn);
  } else if (item.file && /^image\//i.test(item.file.type)) {
    // Thumb aún en camino: esqueleto con el mismo hueco (cero decodificación).
    const skel = document.createElement("div");
    skel.className = "cell-skel";
    skel.setAttribute("aria-hidden", "true");
    div.append(skel, btn);
  } else {
    // PDF u otro sin miniatura: fallback al original.
    const img = document.createElement("img");
    img.src = item.imgUrl; // blob interno de la app, no entrada del usuario
    img.alt = sanear(item.nombre);
    img.draggable = false;
    img.loading = "lazy";
    img.decoding = "async";
    div.append(img, btn);
  }
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
    // Sin LLM el total siempre es manual (flujo N del spec).
    const entrada = document.createElement("input");
    entrada.className = "cell-monto";
    entrada.type = "text";
    entrada.inputMode = "decimal";
    entrada.placeholder = "Total…";
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
        ([f, c, s]) =>
          `<span class="ficha" style="grid-row:${f};grid-column:${c} / span ${s};"></span>`,
      )
      .toArray()
      .join("");
    const activa = id === hoja.layout ? " active" : "";
    return `<button class="grid-opt${activa}" data-accion="layout" data-hoja="${hoja.id}" data-layout="${id}" title="${NOMBRES_LAYOUT[id]}">
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

/** Cuerpo del render (siempre bajo `mutandoHojas`: el swap destruye el foco). */
function renderCuerpo(borrador: BorradorMonto | null): void {
  rectsCache = null;
  const n = totalItems();
  metaHojas.textContent = `${state.hojas.length} hoja${state.hojas.length === 1 ? "" : "s"} · ${n} comprobante${n === 1 ? "" : "s"}`;
  sheetsEl.innerHTML = "";

  if (n === 0) {
    tarjetaVacia.hidden = false;
    renderMonto();
    return;
  }

  state.hojas.forEach((hoja, idx) => {
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
    ico.textContent = "＋";
    mas.append(ico, " Agregar factura");
    lado.append(mas);
    row.append(lado);
    sheetsEl.append(row);
  });
  tarjetaVacia.hidden = true;
  renderMonto();
  if (borrador) restaurarBorrador(borrador);
}

export function renderHojas(): void {
  // Durante un arrastre nunca se reconstruye la grilla: el render se pospone.
  if (pointerDrag) {
    renderPendiente = true;
    return;
  }
  // ponytail: el borrador manual sobrevive a los renders de fondo (cola/IA/giro).
  const borrador = borradorEnEdicion();
  // ponytail: todo change que llegue durante el swap es eco de remoción.
  const render = (): void => {
    bajoMutandoHojas(() => {
      renderCuerpo(borrador);
    });
  };
  // ponytail: sin ViewTransition con reduced-motion ni durante la carga
  // inicial (los snapshots compiten con el drag/scroll); es solo un adorno.
  const reduceMovimiento = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // ponytail: con foco dentro de las hojas el render es síncrono (el swap
  // async pierde el foco y rompe la edición en curso).
  const focoDentro = sheetsEl.contains(document.activeElement);
  if (
    !borrador &&
    !focoDentro &&
    !reduceMovimiento &&
    !state.colaEnProceso &&
    document.startViewTransition
  ) {
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
  redistribuir();
  renderHojas();
}

export function quitarComprobante(id: number): void {
  for (const h of state.hojas) {
    const idx = h.slots.findIndex((c) => c?.id === id);
    if (idx >= 0) {
      const c = h.slots[idx];
      if (c) {
        URL.revokeObjectURL(c.imgUrl);
        if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
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

interface BorradorMonto {
  readonly id: number;
  readonly valor: string;
  readonly inicio: number | null;
  readonly fin: number | null;
}

/** Borrador en curso (input de monto con foco): sobrevive a los renders de fondo. */
function borradorEnEdicion(): BorradorMonto | null {
  if (descartarBorrador) return null;
  const a = document.activeElement;
  if (!(a instanceof HTMLInputElement) || a.dataset["accion"] !== "monto") return null;
  const cell = a.closest(".cell");
  const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
  if (!Number.isInteger(id)) return null;
  return { id, valor: a.value, inicio: a.selectionStart, fin: a.selectionEnd };
}

/** Restaura un borrador tras el render (la celda puede haber cambiado a badge). */
function restaurarBorrador(b: BorradorMonto): void {
  const input = cellById(b.id)?.querySelector<HTMLInputElement>("input.cell-monto");
  if (!input) return;
  input.value = b.valor;
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
    const typed = input.value;
    renderHojas();
    const deNuevo = cellById(id)?.querySelector<HTMLInputElement>("input.cell-monto");
    if (deNuevo) deNuevo.value = typed;
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

// Repinta UNA celda (llegó su miniatura) sin reconstruir la grilla.
export function actualizarMiniatura(id: number): void {
  const cell = cellById(id);
  if (!cell) return;
  const slot = buscarSlot(id);
  if (!slot) return;
  // ponytail: la mini no pisa el borrador en curso de esa celda (y el
  // replaceChildren bajo el flag no commitea el borrador vía change).
  const b = borradorEnEdicion();
  bajoMutandoHojas(() => {
    pintarCelda(cell, slot.hoja.slots[slot.idx] ?? null, slot.idx, slot.hoja.id);
  });
  if (b && b.id === id) restaurarBorrador(b);
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

// ponytail: lupa con el thumb de la grilla como fuente (sincrónica y exacta;
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
  const img = document.elementFromPoint(lupaX, lupaY)?.closest?.(".cell")?.querySelector("img");
  if (img instanceof HTMLImageElement && img.naturalWidth >= 2) {
    // Mapeo exacto con object-fit:contain (bandas según el ratio).
    const r = img.getBoundingClientRect();
    const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    if (s > 0) {
      const lado = Math.min(LUPA_L / LUPA_ZOOM / s, img.naturalWidth, img.naturalHeight);
      if (lado >= 1) {
        const bx = (lupaX - (r.left + (r.width - img.naturalWidth * s) / 2)) / s;
        const by = (lupaY - (r.top + (r.height - img.naturalHeight * s) / 2)) / s;
        const sx = Math.min(Math.max(bx - lado / 2, 0), Math.max(img.naturalWidth - lado, 0));
        const sy = Math.min(Math.max(by - lado / 2, 0), Math.max(img.naturalHeight - lado, 0));
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, sx, sy, lado, lado, 0, 0, LUPA_L, LUPA_L);
        return;
      }
    }
  }
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
  if (!canvasEl) return;
  const r = canvasEl.getBoundingClientRect();
  const margen = 70,
    vel = 14;
  scrollDir = y < r.top + margen ? -vel : y > r.bottom - margen ? vel : 0;
  if (scrollDir && scrollRaf === null) {
    const paso = (): void => {
      if (!scrollDir) {
        detenerScroll();
        return;
      }
      canvasEl.scrollBy?.({ top: scrollDir }); // ?. : jsdom no implementa scrollBy; en Chrome siempre existe.
      if (scrollRaf !== null) scrollRaf = requestAnimationFrame(paso);
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

function celdaBajoPunto(x: number, y: number, excluir: Element | null): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  const directa = el?.closest?.(".cell");
  if (directa instanceof HTMLElement) return directa;
  const hoja = el?.closest?.(".sheet");
  const scope: ParentNode = hoja ?? sheetsEl;
  const celulas = [...scope.querySelectorAll(".cell")].filter((c) => c !== excluir);
  let mejor: HTMLElement | null = null,
    mejorD = Infinity;
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

function iniciarGhost(d: DragState, x: number, y: number): void {
  if (d.ghost) return;
  const celdaOrigen = cellById(d.id);
  if (!celdaOrigen) return;
  // Thumb en camino (esqueleto sin <img>): fantasma desde la caja para no
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

  const ocupante = hojaDestino.slots[slotDestino] ?? null;
  const imgB = ocupante ? cellById(ocupante.id)?.querySelector("img") : null;
  const rB = imgB?.getBoundingClientRect();

  const idsHojasAntes = state.hojas.map((h) => h.id).join();
  const reemplazo = hojaDestino.slots[slotDestino] ?? null;
  const movida = origen.slots[idxOrigen] ?? null;
  hojaDestino.slots[slotDestino] = movida;
  origen.slots[idxOrigen] = reemplazo;
  limpiarHojas();

  const estructural = state.hojas.map((h) => h.id).join() !== idsHojasAntes;
  const nodoOrigen = sheetsEl.querySelector<HTMLElement>(
    `.sheet[data-hoja="${origen.id}"] .cell[data-slot="${idxOrigen}"]`,
  );
  const nodoDestino = sheetsEl.querySelector<HTMLElement>(
    `.sheet[data-hoja="${hojaDestino.id}"] .cell[data-slot="${slotDestino}"]`,
  );
  if (estructural || !nodoOrigen || !nodoDestino) {
    renderHojas();
    return;
  }

  // ponytail: el parche de 2 celdas también destruye inputs con foco.
  bajoMutandoHojas(() => {
    pintarCelda(nodoOrigen, origen.slots[idxOrigen] ?? null, idxOrigen, origen.id);
    pintarCelda(nodoDestino, hojaDestino.slots[slotDestino] ?? null, slotDestino, hojaDestino.id);
  });

  const imgA = nodoDestino.querySelector("img");
  if (imgA) animarFlipDesde(imgA, centroA.x, centroA.y);
  const imgBDestino = nodoOrigen.querySelector("img");
  if (imgBDestino && rB)
    animarFlipDesde(imgBDestino, rB.left + rB.width / 2, rB.top + rB.height / 2);

  actualizarConteoPanel(origen);
  if (hojaDestino !== origen) actualizarConteoPanel(hojaDestino);
  renderMonto();
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
}

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

export function initSheets(cb: SheetsCallbacks): void {
  // ponytail: guard anti doble-cableado (HMR/tests llaman más de una vez).
  if (sheetsEl.dataset["init"] === "1") return;
  sheetsEl.dataset["init"] = "1";
  sheetsEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (state.modoOcr) return;
    const target = e.target as HTMLElement | null;
    const cell = target?.closest?.(".cell");
    if (!(cell instanceof HTMLElement) || cell.classList.contains("empty")) return;
    if (
      target?.closest?.(
        '[data-accion="quitar"],[data-accion="girar-izq"],[data-accion="girar-der"],[data-accion="monto"],[data-accion="corregir-monto"]',
      )
    )
      return;
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
    if ((e.key === "m" || e.key === "M") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t?.isContentEditable
      )
        return;
      setLupa(!lupaActiva);
    }
    // ponytail: atajos mínimos para no dejar el zoom solo al puntero (a11y teclado).
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_" || e.key === "0")
    ) {
      e.preventDefault();
      if (e.key === "0") {
        zoomEscala = 1;
        aplicarZoom();
        return;
      }
      zoomCentrado(e.key === "+" || e.key === "=" ? 1.2 : 1 / 1.2);
    }
  });

  // Evento delegado: un solo listener, switch por data-accion.
  sheetsEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest?.("[data-accion]");
    if (!(btn instanceof HTMLElement)) return;
    const accion = btn.dataset["accion"];
    const cell = btn.closest(".cell");
    const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
    switch (accion) {
      case "copiar-ocr": {
        const item = obtenerComprobante(id);
        if (!item) return;
        if (!item.textoOcr) return;
        // Sin Promise.try (ausente en Node 22 del CI): writeText ya devuelve promesa.
        // clipboard no existe fuera de contexto seguro (http): TypeError antes de la promesa.
        const fallo = "Copiar falló (sin permiso del portapapeles)";
        const portapapeles = navigator.clipboard;
        if (typeof portapapeles?.writeText !== "function") {
          btn.title = fallo;
          return;
        }
        void portapapeles.writeText(item.textoOcr).catch(() => {
          btn.title = fallo;
        });
        return;
      }
      case "quitar":
        quitarComprobante(id);
        return;
      case "girar-izq":
        void girarYReleer(id, 270);
        return;
      case "girar-der":
        void girarYReleer(id, 90);
        return;
      case "corregir-monto": {
        const item = obtenerComprobante(id);
        // ponytail: apertura no destructiva (el valor previo se edita, no se
        // borra); fuera de ok no hay input que mostrar. Sin reintento IA: la
        // IA solo entra por subida/botón/giro.
        if (!item || item.estado !== "ok") return;
        editandoMonto = id;
        renderHojas();
        enfocarMonto(id, true);
        return;
      }
      case "layout":
        cambiarLayoutHoja(btn.dataset["hoja"] ?? "", btn.dataset["layout"] ?? "");
        return;
      case "apply-all":
        aplicarATodas(btn.dataset["hoja"] ?? "");
        return;
      case "agregar": {
        const destino = Number(btn.dataset["hoja"]);
        if (Number.isInteger(destino)) cb.pedirArchivos(destino);
        return;
      }
    }
  });

  // Monto manual: un solo change delegado (el render reconstruye la grilla).
  sheetsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement) || target.dataset["accion"] !== "monto") return;
    // ponytail: eco de remoción (el swap destruyó el input enfocado): nunca es edición.
    if (esEcoDeRemocion(target)) return;
    commitearMonto(target);
  });

  // Monto manual por teclado: Enter confirma, Escape cancela el borrador.
  sheetsEl.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement) || target.dataset["accion"] !== "monto") return;
    const cell = target.closest(".cell");
    const id = Number(cell instanceof HTMLElement ? cell.dataset["id"] : NaN);
    if (!Number.isInteger(id)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      // ponytail: commit directo (sin blur): el foco sigue en el input y el
      // render sale síncrono, así el badge ya existe al enfocarlo.
      const confirmado = commitearMonto(target, true);
      if (confirmado !== null) {
        cellById(confirmado)?.querySelector<HTMLElement>(".cell-badge")?.focus();
      }
      return;
    }
    if (e.key === "Escape") {
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
      cellById(id)?.focus();
    }
  });

  // Drag nativo de archivos del explorador (DataTransfer) sobre las hojas.
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
    if (sheet instanceof HTMLElement) sheet.classList.add("file-drop");
  });

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

  sheetsEl.addEventListener("drop", (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    const target = e.target as HTMLElement | null;
    const sheet = target?.closest?.(".sheet");
    cancelarDragVisual();
    if (sheet instanceof HTMLElement)
      cb.agregarArchivos(e.dataTransfer?.files, Number(sheet.dataset["hoja"]));
  });

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

  // ponytail: la lupa no consume wheel (el ctrl+rueda sigue al zoom) ni clics.
  const zonaLupa = canvasEl ?? sheetsEl;
  zonaLupa.addEventListener("pointermove", (e) => {
    if (!lupaActiva) return;
    lupaX = e.clientX;
    lupaY = e.clientY;
    lupaTieneMuestra = true;
    lupaEl.style.opacity = "1";
    if (lupaRaf === null) lupaRaf = requestAnimationFrame(dibujarLupa);
  });
  zonaLupa.addEventListener("pointerleave", () => {
    lupaTieneMuestra = false;
    lupaEl.style.opacity = "0";
  });
  zonaLupa.addEventListener("pointerenter", (e) => {
    if (!lupaActiva) return;
    lupaX = e.clientX;
    lupaY = e.clientY;
    lupaTieneMuestra = true;
    lupaEl.style.opacity = "1";
    if (lupaRaf === null) lupaRaf = requestAnimationFrame(dibujarLupa);
  });
}
