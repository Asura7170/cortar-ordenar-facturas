/* Hojas carta: render de casillas + drag & drop de comprobantes. */
import { buscarSlot, guardar, hojaPorId, limpiarHojas, redistribuir, state } from '../state';
import type { Comprobante, Hoja, Plantilla } from '../types';
import { NOMBRES_LAYOUT, ORDEN_PLANTILLAS, PLANTILLAS, isLayoutId, layoutDe } from './layout';
import { aplanar, cuentaHoja, formatearMoneda, renderMonto, totalItems } from './monto';
import { getEl, sanear } from '../utils';

const sheetsEl: HTMLElement = getEl('sheets');
const metaHojas: HTMLElement = getEl('metaHojas');
const canvasEl: HTMLElement | null = document.querySelector('.canvas');

/* ---------- Render de casillas (sin innerHTML para datos del usuario) ---------- */

function celda(item: Comprobante | null, pos: Plantilla['pos'][number] | undefined, slotIdx: number, hojaId: number): HTMLElement {
  const estilo = pos ? `grid-row: ${pos[0]}; grid-column: ${pos[1]} / span ${pos[2]};` : '';
  const div = document.createElement('div');
  div.className = 'cell';
  div.style.cssText = estilo;
  pintarCelda(div, item, slotIdx, hojaId);
  return div;
}

// El grid-area pertenece al slot, no al contenido: el swap parchea solo 2
// celdas sin reconstruir la grilla entera.
function pintarCelda(div: HTMLElement, item: Comprobante | null, slotIdx: number, hojaId: number): void {
  div.replaceChildren();
  div.className = 'cell';
  delete div.dataset['id'];
  div.dataset['slot'] = String(slotIdx);
  div.dataset['hoja'] = String(hojaId);
  // Solo la celda ocupada es tabulable: así el × se revela por :focus-within.
  div.tabIndex = item === null ? -1 : 0;

  if (!item) {
    div.classList.add('empty');
    div.textContent = 'Vacío';
    return;
  }

  div.dataset['id'] = String(item.id);

  if (state.modoOcr) {
    div.classList.add('cell-ocr');
    const pre = document.createElement('pre');
    pre.className = 'cell-ocr-text';
    pre.textContent = sanear(item.textoOcr || (item.estado === 'procesando' ? 'Procesando…'
      : item.estado === 'pendiente' ? '(pendiente)'
      : '(sin texto OCR)'));
    const btn = document.createElement('button');
    btn.className = 'cell-remove';
    btn.dataset['accion'] = 'copiar-ocr';
    btn.title = 'Copiar OCR';
    btn.setAttribute('aria-label', 'Copiar OCR');
    btn.textContent = '⧉';
    div.append(pre, btn);
    return;
  }

  div.classList.add(`cell-${item.estado}`);
  const btn = document.createElement('button');
  btn.className = 'cell-remove';
  btn.dataset['accion'] = 'quitar';
  btn.title = 'Quitar';
  btn.setAttribute('aria-label', 'Quitar comprobante');
  btn.textContent = '×';
  if (item.thumbUrl) {
    const img = document.createElement('img');
    img.src = item.thumbUrl; // solo el thumb: el full-res nunca se decodifica en la grilla
    img.alt = sanear(item.nombre);
    img.draggable = false;
    img.loading = 'lazy';
    img.decoding = 'async';
    div.append(img, btn);
  } else if (item.file && /^image\//i.test(item.file.type)) {
    // Thumb aún en camino: esqueleto con el mismo hueco (cero decodificación).
    const skel = document.createElement('div');
    skel.className = 'cell-skel';
    skel.setAttribute('aria-hidden', 'true');
    div.append(skel, btn);
  } else {
    // PDF u otro sin miniatura: fallback al original.
    const img = document.createElement('img');
    img.src = item.imgUrl; // blob interno de la app, no entrada del usuario
    img.alt = sanear(item.nombre);
    img.draggable = false;
    img.loading = 'lazy';
    img.decoding = 'async';
    div.append(img, btn);
  }
  if (item.montoCents != null) {
    const badge = document.createElement('span');
    badge.className = 'cell-badge';
    badge.textContent = formatearMoneda(item.montoCents);
    div.append(badge);
  }
}

function panelHoja(hoja: Hoja, idx: number): string {
  // innerHTML solo con datos internos (plantillas): nunca nombre/textoOcr del usuario.
  const tarjetas = ORDEN_PLANTILLAS.map((id) => {
    const l = PLANTILLAS[id];
    const fichas = Iterator.from(l.pos).map(([f, c, s]) => `<span class="ficha" style="grid-row:${f};grid-column:${c} / span ${s};"></span>`).toArray().join('');
    const activa = id === hoja.layout ? ' active' : '';
    return `<button class="grid-opt${activa}" data-accion="layout" data-hoja="${hoja.id}" data-layout="${id}" title="${NOMBRES_LAYOUT[id]}">
      <span class="layout-mini" style="grid-template-columns:repeat(${l.cols},1fr);grid-template-rows:repeat(${l.filas},1fr);" aria-hidden="true">${fichas}</span>
      <span class="layout-name">${NOMBRES_LAYOUT[id]}</span>
    </button>`;
  }).join('');
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

export function renderHojas(): void {
  // Durante un arrastre nunca se reconstruye la grilla: el render se pospone.
  if (pointerDrag) { renderPendiente = true; return; }
  const render = (): void => {
    rectsCache = null;
    const n = totalItems();
    metaHojas.textContent = `${state.hojas.length} hoja${state.hojas.length === 1 ? '' : 's'} · ${n} comprobante${n === 1 ? '' : 's'}`;
    sheetsEl.innerHTML = '';

    if (n === 0) {
      sheetsEl.innerHTML = `
        <div class="empty-state">
          <h2>Comenzá pegando tus comprobantes</h2>
          <p>Usá <strong>Ctrl+V</strong>, arrastrá imágenes o hacé clic en el cuadro de entrada. Cada comprobante se recorta, se lee su texto y se suma su total.</p>
        </div>`;
      renderMonto();
      return;
    }

    state.hojas.forEach((hoja, idx) => {
      const l = layoutDe(hoja.layout);
      const sheet = document.createElement('article');
      sheet.className = 'sheet';
      sheet.dataset['hoja'] = String(hoja.id);
      const grid = document.createElement('div');
      grid.className = 'sheet-grid';
      grid.style.cssText = `grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)`;
      l.pos.forEach((p, i) => grid.append(celda(hoja.slots[i] ?? null, p, i, hoja.id)));
      const tag = document.createElement('span');
      tag.className = 'sheet-tag';
      tag.textContent = `HOJA ${idx + 1}`;
      sheet.append(tag, grid);

      const row = document.createElement('div');
      row.className = 'sheet-row';
      row.dataset['hoja'] = String(hoja.id);
      row.innerHTML = panelHoja(hoja, idx);
      row.insertBefore(sheet, row.firstChild);
      sheetsEl.append(row);
    });
    renderMonto();
  };
  // ponytail: sin ViewTransition con reduced-motion ni durante la carga
  // inicial (los snapshots compiten con el drag/scroll); es solo un adorno.
  const reduceMovimiento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!reduceMovimiento && !state.colaEnProceso && document.startViewTransition) {
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
  guardar();
  renderHojas();
}

export function aplicarATodas(hojaId: string | number): void {
  const h = hojaPorId(hojaId);
  if (!h) return;
  const layoutId = h.layout;
  state.hojas.forEach((x) => { x.layout = layoutId; });
  redistribuir();
  guardar();
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
  guardar();
  renderHojas();
}

function cellById(id: number): HTMLElement | null {
  return sheetsEl.querySelector<HTMLElement>(`.cell[data-id="${id}"]`);
}

// Repinta UNA celda (llegó su miniatura) sin reconstruir la grilla.
export function actualizarMiniatura(id: number): void {
  const cell = cellById(id);
  if (!cell) return;
  const slot = buscarSlot(id);
  if (!slot) return;
  pintarCelda(cell, slot.hoja.slots[slot.idx] ?? null, slot.idx, slot.hoja.id);
}

/* ---------- Drag entre casillas (Pointer Events: mover/swap) ---------- */

interface DragState {
  id: number;
  ghost: HTMLImageElement | null;
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
let moveRaf: number | null = null;
let celdaResaltada: HTMLElement | null = null;
let rectsCache: Map<Element, DOMRect> | null = null;
let renderPendiente = false;

function detenerScroll(): void {
  if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
}

function cancelarDragVisual(): void {
  sheetsEl.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
  sheetsEl.querySelectorAll('.sheet-grid.dragging').forEach((g) => g.classList.remove('dragging'));
  sheetsEl.querySelectorAll('.sheet.file-drop').forEach((s) => s.classList.remove('file-drop'));
  sheetsEl.querySelectorAll('.cell.pickup').forEach((c) => c.classList.remove('pickup'));
  document.querySelectorAll('.drag-ghost').forEach((g) => g.remove());
  document.body.classList.remove('is-dragging');
  celdaResaltada = null;
  rectsCache = null;
  if (moveRaf !== null) { cancelAnimationFrame(moveRaf); moveRaf = null; }
  detenerScroll();
  const sel = window.getSelection();
  if (sel?.rangeCount) sel.removeAllRanges();
}

function autoScroll(x: number, y: number): void {
  if (!canvasEl) return;
  const r = canvasEl.getBoundingClientRect();
  const margen = 70, vel = 14;
  const dir = y < r.top + margen ? -vel : y > r.bottom - margen ? vel : 0;
  if (dir && scrollRaf === null) {
    const paso = (): void => {
      canvasEl.scrollBy({ top: dir });
      if (dir && scrollRaf !== null) scrollRaf = requestAnimationFrame(paso);
    };
    scrollRaf = requestAnimationFrame(paso);
  } else if (!dir) {
    detenerScroll();
  }
}

export function esDragDeArchivos(e: DragEvent): boolean {
  return Iterator.from(e.dataTransfer?.types ?? []).some((t) => t === 'Files');
}

// Rects cacheados durante el drag: getBoundingClientRect 1 vez por layout real.
function celdaRect(c: Element): DOMRect {
  if (!rectsCache) {
    rectsCache = new Map();
    for (const el of sheetsEl.querySelectorAll('.cell')) rectsCache.set(el, el.getBoundingClientRect());
  }
  let r = rectsCache.get(c);
  if (!r) { r = c.getBoundingClientRect(); rectsCache.set(c, r); }
  return r;
}

function celdaBajoPunto(x: number, y: number, excluir: Element | null): HTMLElement | null {
  const el = document.elementFromPoint(x, y);
  const directa = el?.closest?.('.cell');
  if (directa instanceof HTMLElement) return directa;
  const hoja = el?.closest?.('.sheet');
  const scope: ParentNode = hoja ?? sheetsEl;
  const celulas = [...scope.querySelectorAll('.cell')].filter((c) => c !== excluir);
  let mejor: HTMLElement | null = null, mejorD = Infinity;
  for (const c of celulas) {
    const r = celdaRect(c);
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < mejorD && c instanceof HTMLElement) { mejorD = d; mejor = c; }
  }
  return mejorD < 150 ? mejor : null;
}

function iniciarGhost(d: DragState, x: number, y: number): void {
  if (d.ghost) return;
  const celdaOrigen = cellById(d.id);
  const img = celdaOrigen?.querySelector('img');
  if (!img || !celdaOrigen) return;
  const r = img.getBoundingClientRect();
  const base = r.width > 2 ? r : celdaOrigen.getBoundingClientRect();
  const ghost = img.cloneNode(true) as HTMLImageElement;
  ghost.className = 'drag-ghost';
  ghost.style.width = `${base.width}px`;
  ghost.style.height = `${base.height}px`;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.gw = base.width / 2;
  d.gh = base.height / 2;
  d.activo = true;
  celdaOrigen.classList.add('pickup');
  document.body.classList.add('is-dragging');
  posicionarGhost(d, x, y);
}

// El ghost se mueve solo con transform (compositor): cero lecturas de layout.
function posicionarGhost(d: DragState, x: number, y: number): void {
  d.ghost?.style.setProperty('transform', `translate(${x - d.gw}px, ${y - d.gh}px) rotate(1.5deg) scale(1.04)`);
}

function resaltarDestino(cell: HTMLElement | null): void {
  if (cell && cell.dataset['id'] === String(pointerDrag?.id)) cell = null;
  if (cell === celdaResaltada) return;
  celdaResaltada?.classList.remove('drop-target');
  celdaResaltada = null;
  if (cell && sheetsEl.contains(cell)) {
    cell.classList.add('drop-target');
    celdaResaltada = cell;
  }
}

// FLIP "Play": vuela `img` desde un centro aparente hasta su posición real.
function animarFlipDesde(img: HTMLImageElement, cx: number, cy: number): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = img.getBoundingClientRect();
  if (r.width < 2) return;
  const dx = cx - (r.left + r.width / 2);
  const dy = cy - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < 2) return;
  void img.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
    { duration: 170, easing: 'cubic-bezier(.2, .8, .2, 1)' },
  );
}

function actualizarConteoPanel(hoja: Hoja): void {
  const span = sheetsEl.querySelector(`.sheet-row[data-hoja="${hoja.id}"] .sheet-panel-count`);
  if (span) span.textContent = `${cuentaHoja(hoja)}/${layoutDe(hoja.layout).total}`;
}

// Mueve (o intercambia) al slot pedido repintando solo 2 casillas + FLIP.
function moverSlot(drag: { id: number }, hojaDestino: Hoja, slotDestino: number, centroA: { x: number; y: number }): void {
  const actual = buscarSlot(drag.id);
  if (!actual) return;
  const { hoja: origen, idx: idxOrigen } = actual;
  if (origen === hojaDestino && idxOrigen === slotDestino) return;

  const ocupante = hojaDestino.slots[slotDestino] ?? null;
  const imgB = ocupante ? cellById(ocupante.id)?.querySelector('img') : null;
  const rB = imgB?.getBoundingClientRect();

  const idsHojasAntes = state.hojas.map((h) => h.id).join();
  const reemplazo = hojaDestino.slots[slotDestino] ?? null;
  const movida = origen.slots[idxOrigen] ?? null;
  hojaDestino.slots[slotDestino] = movida;
  origen.slots[idxOrigen] = reemplazo;
  limpiarHojas();
  guardar();

  const estructural = state.hojas.map((h) => h.id).join() !== idsHojasAntes;
  const nodoOrigen = sheetsEl.querySelector<HTMLElement>(`.sheet[data-hoja="${origen.id}"] .cell[data-slot="${idxOrigen}"]`);
  const nodoDestino = sheetsEl.querySelector<HTMLElement>(`.sheet[data-hoja="${hojaDestino.id}"] .cell[data-slot="${slotDestino}"]`);
  if (estructural || !nodoOrigen || !nodoDestino) { renderHojas(); return; }

  pintarCelda(nodoOrigen, origen.slots[idxOrigen] ?? null, idxOrigen, origen.id);
  pintarCelda(nodoDestino, hojaDestino.slots[slotDestino] ?? null, slotDestino, hojaDestino.id);

  const imgA = nodoDestino.querySelector('img');
  if (imgA) animarFlipDesde(imgA, centroA.x, centroA.y);
  const imgBDestino = nodoOrigen.querySelector('img');
  if (imgBDestino && rB) animarFlipDesde(imgBDestino, rB.left + rB.width / 2, rB.top + rB.height / 2);

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
  const hojaDestino = hojaPorId(cell.closest('.sheet')?.getAttribute('data-hoja') ?? '');
  const slotDestino = Number(cell.dataset['slot']);
  if (!hojaDestino || !Number.isInteger(slotDestino)) return;
  moverSlot(drag, hojaDestino, slotDestino, { x, y });
}

export interface SheetsCallbacks {
  agregarArchivos: (files: FileList | File[] | null | undefined, hojaId?: number | null) => void;
}

export function initSheets(cb: SheetsCallbacks): void {
  sheetsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    if (state.modoOcr) return;
    const target = e.target as HTMLElement | null;
    const cell = target?.closest?.('.cell');
    if (!(cell instanceof HTMLElement) || cell.classList.contains('empty')) return;
    if (target?.closest?.('[data-accion="quitar"]')) return;
    e.preventDefault();
    if (pointerDrag) {
      pointerDrag = null;
      cancelarDragVisual();
    }
    pointerDrag = {
      id: Number(cell.dataset['id']),
      ghost: null, gw: 0, gh: 0,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      activo: false,
    };
    cell.closest('.sheet-grid')?.classList.add('dragging');
    try { sheetsEl.setPointerCapture(e.pointerId); } catch { /* puntero ya inactivo */ }
  });

  document.addEventListener('pointermove', (e) => {
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

  document.addEventListener('pointerup', (e) => finalizarDrag(e.clientX, e.clientY));

  sheetsEl.addEventListener('lostpointercapture', (e) => {
    if (!e.isPrimary || !pointerDrag) return;
    finalizarDrag(pointerDrag.lastX, pointerDrag.lastY);
  });

  document.addEventListener('pointercancel', () => {
    if (!pointerDrag) return;
    pointerDrag = null;
    cancelarDragVisual();
    soltarRenderPendiente();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pointerDrag) {
      pointerDrag = null;
      cancelarDragVisual();
      soltarRenderPendiente();
    }
  });

  // Evento delegado: un solo listener, switch por data-accion.
  sheetsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest?.('[data-accion]');
    if (!(btn instanceof HTMLElement)) return;
    const accion = btn.dataset['accion'];
    const cell = btn.closest('.cell');
    const id = Number(cell instanceof HTMLElement ? cell.dataset['id'] : NaN);
    switch (accion) {
      case 'copiar-ocr': {
        const item = aplanar().find((c) => c.id === id);
        if (!item) return;
        if (!item.textoOcr) return;
        void Promise.try(() => navigator.clipboard.writeText(item.textoOcr));
        return;
      }
      case 'quitar':
        quitarComprobante(id);
        return;
      case 'layout':
        cambiarLayoutHoja(btn.dataset['hoja'] ?? '', btn.dataset['layout'] ?? '');
        return;
      case 'apply-all':
        aplicarATodas(btn.dataset['hoja'] ?? '');
        return;
    }
  });

  // Drag nativo de archivos del explorador (DataTransfer) sobre las hojas.
  sheetsEl.addEventListener('dragover', (e) => {
    if (!esDragDeArchivos(e) || state.modoOcr) return;
    e.preventDefault();
    autoScroll(e.clientX, e.clientY);
    const target = e.target as HTMLElement | null;
    const sheet = target?.closest?.('.sheet');
    sheetsEl.querySelectorAll('.sheet.file-drop').forEach((s) => { if (s !== sheet) s.classList.remove('file-drop'); });
    if (sheet instanceof HTMLElement) sheet.classList.add('file-drop');
  });

  sheetsEl.addEventListener('dragleave', (e) => {
    if (!esDragDeArchivos(e)) return;
    const target = e.target as HTMLElement | null;
    const related = e.relatedTarget as Node | null;
    const sheet = target?.closest?.('.sheet');
    if (sheet instanceof HTMLElement && !sheet.contains(related)) sheet.classList.remove('file-drop');
  });

  sheetsEl.addEventListener('drop', (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    if (state.modoOcr) return;
    const target = e.target as HTMLElement | null;
    const sheet = target?.closest?.('.sheet');
    cancelarDragVisual();
    if (sheet instanceof HTMLElement) cb.agregarArchivos(e.dataTransfer?.files, Number(sheet.dataset['hoja']));
  });

  canvasEl?.addEventListener('scroll', () => { rectsCache = null; }, { passive: true });
}
