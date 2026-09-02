/* ============================================================
   CORTAR Y ORDENAR FACTURAS — app.js (módulo ES)
   Diseño 1 · Libro Mayor
   ------------------------------------------------------------------
   Flujo completo:
   - entrada (dropzone / pegar / subir)
   - cola secuencial de procesamiento (placeholder para OpenCV+OCR)
   - monto acumulado en cents (suma exacta)
   - hojas independientes con N propio (1-6) vía panel de distribución
   - código de pedido persistente, modo OCR y ajustes
   - export .docx (stub que arma un Blob)
   - drag & drop de comprobantes entre casillas (mover/swap)
   ============================================================ */

/* ---------- Estado global ---------- */
const state = {
  hojas: [],             // [{id, layout, slots:[comprobante|null...]}] — una casilla fija por posición de la plantilla
  codigoActivo: false,
  codigoLongitud: 6,
  codigoValor: '',
  configIA: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  moneda: 'USD',
  colaEnProceso: false,
  modoOcr: false,
};

const LS_KEY = 'libro-mayor-state';
const MONEDAS = { USD: { simbolo: 'US$', factor: 1 }, ARS: { simbolo: 'AR$', factor: 1 }, EUR: { simbolo: '€', factor: 1 } };

let seq = 0;        // ids de comprobantes
let seqHoja = 0;    // ids de hojas

/* ---------- Referencias DOM ---------- */
const $ = (id) => document.getElementById(id);
const sheetsEl = $('sheets');
const montoEl = $('montoTotal');
const metaHojas = $('metaHojas');
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const chkCodigo = $('chkCodigo');
const numCodigo = $('numCodigo');
const inputCodigo = $('inputCodigo');
const btnLimpiar = $('btnLimpiar');
const btnDescargar2 = $('btnDescargar2');
const btnAjustes = $('btnAjustes');
const btnTema = $('btnTema');
const temaIcono = $('temaIcono');

/* ---------- Saneamiento (seguridad) ---------- */
// Los nombres de archivo y textos OCR son entrada del usuario: se sanean antes
// de tocar el DOM. toWellFormed() repara surrogates sueltos (Chrome 111+).
const sanear = (s) => String(s ?? '').toWellFormed();

/* ---------- Miniaturas ---------- */
// La imagen completa queda en item.imgUrl (para el futuro recorte/exportación);
// en pantalla se muestra un WebP reducido: así el render, el ghost del drag y la
// memoria no dependen de bitmaps de decenas de megapíxeles.
const THUMB_MAX = 1280; // ≈ 2× la celda más grande de la hoja (pantallas 2x)

async function generarMiniatura(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const escala = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
    let red = bmp;
    if (escala < 1) {
      red = await createImageBitmap(bmp, {
        resizeWidth: Math.max(1, Math.round(bmp.width * escala)),
        resizeHeight: Math.max(1, Math.round(bmp.height * escala)),
        resizeQuality: 'high',
      });
      bmp.close();
    }
    const canvas = document.createElement('canvas');
    canvas.width = red.width;
    canvas.height = red.height;
    canvas.getContext('2d').drawImage(red, 0, 0);
    red.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.82));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null; // PDF o imagen no decodificable: se muestra el original
  }
}

/* ---------- Persistencia ---------- */
function guardar() {
  const persist = {
    codigoActivo: state.codigoActivo,
    codigoLongitud: state.codigoLongitud,
    codigoValor: state.codigoValor,
    moneda: state.moneda,
    configIA: state.configIA,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(persist));
}

function cargar() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    state.codigoActivo = Object.hasOwn(p, 'codigoActivo') ? p.codigoActivo : false;
    state.codigoLongitud = Object.hasOwn(p, 'codigoLongitud') ? p.codigoLongitud : 6;
    state.codigoValor = Object.hasOwn(p, 'codigoValor') ? p.codigoValor : '';
    state.moneda = Object.hasOwn(p, 'moneda') ? p.moneda : 'USD';
    state.configIA = { ...state.configIA, ...(p.configIA || {}) };
  } catch { /* estado corrupto: ignorar */ }
}

/* ---------- Monetario ---------- */
function formatearMoneda(cents) {
  const m = MONEDAS[state.moneda] || MONEDAS.USD;
  return `${m.simbolo} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sumaTotal() {
  return Iterator.from(state.hojas).flatMap(itemsDe).reduce((acc, c) => acc + (c.montoCents || 0), 0);
}

function renderMonto() {
  montoEl.textContent = formatearMoneda(sumaTotal());
}

function totalItems() {
  return Iterator.from(state.hojas).flatMap(itemsDe).reduce((acc) => acc + 1, 0);
}

function itemsDe(hoja) { return Iterator.from(hoja.slots).filter(Boolean).toArray(); }
function cuentaHoja(hoja) { return itemsDe(hoja).length; }

// Orden visual global (por slots, huecos ignorados)
function aplanar() {
  return Iterator.from(state.hojas).flatMap((h) => itemsDe(h)).toArray();
}

function crearHoja(layoutId = 'u4x2') {
  const l = layoutDe(layoutId);
  return { id: ++seqHoja, layout: l.id, slots: Array(l.total).fill(null) };
}

function hojaPorId(id) {
  return state.hojas.find((h) => h.id === Number(id));
}

// Posición actual {hoja, idx} de un comprobante por id, o null si ya no existe.
function buscarSlot(id) {
  for (const h of state.hojas) {
    const idx = h.slots.findIndex((c) => c?.id === id);
    if (idx >= 0) return { hoja: h, idx };
  }
  return null;
}

function limpiarHojas() {
  state.hojas = Iterator.from(state.hojas).filter((h) => h.slots.some(Boolean)).toArray();
  if (state.hojas.length === 0) state.hojas.push(crearHoja());
}

// Reparte todos los comprobantes en orden visual respetando la capacidad de cada hoja:
// rellena los slots consecutivamente (recompacta, sin huecos) y crea hojas al final si sobran.
function redistribuir() {
  const items = aplanar();
  let pos = 0;
  for (const h of state.hojas) {
    const cap = layoutDe(h.layout).total;
    h.slots = Array(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = items[pos++];
  }
  while (pos < items.length) {
    const h = crearHoja(state.hojas[state.hojas.length - 1].layout);
    const cap = layoutDe(h.layout).total;
    h.slots = Array(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = items[pos++];
    state.hojas.push(h);
  }
  limpiarHojas();
}

function cambiarLayoutHoja(hojaId, layoutId) {
  const h = hojaPorId(hojaId);
  if (!h || !PLANTILLAS[layoutId]) return;
  h.layout = layoutId;
  redistribuir();
  guardar();
  renderHojas();
}

function aplicarATodas(hojaId) {
  const h = hojaPorId(hojaId);
  if (!h) return;
  const layoutId = h.layout;
  state.hojas.forEach((x) => { x.layout = layoutId; });
  redistribuir();
  guardar();
  renderHojas();
}

/* ---------- Plantillas de distribución ---------- */
// Cada plantilla define filas/columnas del grid de la hoja y la posición
// [fila, columna, span] de cada comprobante. La mini-vista replica esta grilla.
const PLANTILLAS = {
  u1:   { total: 1, filas: 1, cols: 2, pos: [[1, 1, 2]] },
  u2h:  { total: 2, filas: 1, cols: 2, pos: [[1, 1, 1], [1, 2, 1]] },
  u2v:  { total: 2, filas: 2, cols: 1, pos: [[1, 1, 1], [2, 1, 1]] },
  u3h:  { total: 3, filas: 1, cols: 3, pos: [[1, 1, 1], [1, 2, 1], [1, 3, 1]] },
  u3v:  { total: 3, filas: 3, cols: 1, pos: [[1, 1, 1], [2, 1, 1], [3, 1, 1]] },
  u3m:  { total: 3, filas: 2, cols: 2, pos: [[1, 1, 1], [1, 2, 1], [2, 1, 2]] },
  u4x2: { total: 4, filas: 2, cols: 2, pos: [[1, 1, 1], [1, 2, 1], [2, 1, 1], [2, 2, 1]] },
  u5m:  { total: 5, filas: 2, cols: 6, pos: [[1, 1, 2], [1, 3, 2], [1, 5, 2], [2, 2, 2], [2, 4, 2]] },
  u6x2: { total: 6, filas: 2, cols: 3, pos: [[1, 1, 1], [1, 2, 1], [1, 3, 1], [2, 1, 1], [2, 2, 1], [2, 3, 1]] },
  u6m:  { total: 6, filas: 3, cols: 2, pos: [[1, 1, 1], [1, 2, 1], [2, 1, 1], [2, 2, 1], [3, 1, 1], [3, 2, 1]] },
};

const NOMBRES_LAYOUT = {
  u1: '1 · Centrado',
  u2h: '2 · Fila', u2v: '2 · Columna',
  u3h: '3 · Fila', u3v: '3 · Columna', u3m: '3 · 2+1',
  u4x2: '4 · Cuadrado',
  u5m: '5 · 3+2',
  u6x2: '6 · 3×2', u6m: '6 · 2+2+2',
};

// Orden de presentación en el panel (agrupado por cantidad de comprobantes)
const ORDEN_PLANTILLAS = ['u1', 'u2h', 'u2v', 'u3h', 'u3v', 'u3m', 'u4x2', 'u5m', 'u6x2', 'u6m'];

function layoutDe(id) {
  return PLANTILLAS[id] || PLANTILLAS.u4x2;
}

/* ---------- Render de casillas (seguro: sin innerHTML para datos del usuario) ---------- */
// Construimos nodos con createElement + textContent para nombre/textoOcr.
// Los data-* y clases son el contrato del drag (data-id/slot/hoja, .cell, .empty...).
function celda(item, pos, slotIdx, hojaId) {
  const estilo = pos ? `grid-row: ${pos[0]}; grid-column: ${pos[1]} / span ${pos[2]};` : '';
  const div = document.createElement('div');
  div.className = 'cell';
  div.style.cssText = estilo;
  pintarCelda(div, item, slotIdx, hojaId);
  return div;
}

// Pinta (o repinta) el contenido de una celda sobre un nodo existente.
// El grid-area pertenece al slot, no al contenido: por esto el swap puede
// parchear solo 2 celdas sin reconstruir la grilla entera.
function pintarCelda(div, item, slotIdx, hojaId) {
  div.replaceChildren();
  div.className = 'cell';
  delete div.dataset.id;
  div.dataset.slot = slotIdx;
  div.dataset.hoja = hojaId;

  if (!item) {
    div.classList.add('empty');
    div.textContent = 'Vacío';
    return;
  }

  div.dataset.id = item.id;

  // Modo OCR: la casilla muestra el texto OCR en lugar de la imagen
  if (state.modoOcr) {
    div.classList.add('cell-ocr');
    const pre = document.createElement('pre');
    pre.className = 'cell-ocr-text';
    let texto = item.textoOcr;
    if (!texto) {
      texto = item.estado === 'procesando' ? 'Procesando…'
        : item.estado === 'pendiente' ? '(pendiente)'
        : '(sin texto OCR)';
    }
    pre.textContent = sanear(texto);
    const btn = document.createElement('button');
    btn.className = 'cell-remove';
    btn.dataset.accion = 'copiar-ocr';
    btn.title = 'Copiar OCR';
    btn.setAttribute('aria-label', 'Copiar OCR');
    btn.textContent = '⧉';
    div.append(pre, btn);
    return;
  }

  div.classList.add(`cell-${item.estado}`);
  const img = document.createElement('img');
  img.src = item.thumbUrl || item.imgUrl; // blob interno generado por la app (no es entrada del usuario)
  img.alt = sanear(item.nombre);
  img.draggable = false;
  img.loading = 'lazy';
  img.decoding = 'async';
  const btn = document.createElement('button');
  btn.className = 'cell-remove';
  btn.dataset.accion = 'quitar';
  btn.title = 'Quitar';
  btn.textContent = '×';
  div.append(img, btn);
  if (item.montoCents != null) {
    const badge = document.createElement('span');
    badge.className = 'cell-badge';
    badge.textContent = formatearMoneda(item.montoCents);
    div.append(badge);
  }
}

function panelHoja(hoja, idx) {
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

function renderHojas() {
  // Durante un arrastre nunca se reconstruye la grilla (rompería nodos y rects en
  // uso): el render se pospone y se aplica al cerrar el drag.
  if (pointerDrag) { renderPendiente = true; return; }
  const render = () => {
    rectsCache = null; // el árbol cambió: los rects congelados ya no sirven
    metaHojas.textContent = `${state.hojas.length} hoja${state.hojas.length === 1 ? '' : 's'} · ${totalItems()} comprobante${totalItems() === 1 ? '' : 's'}`;
    sheetsEl.innerHTML = '';

    if (totalItems() === 0) {
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
      sheet.dataset.hoja = hoja.id;
      const grid = document.createElement('div');
      grid.className = 'sheet-grid';
      grid.style.cssText = `grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)`;
      l.pos.forEach((p, i) => grid.append(celda(hoja.slots[i], p, i, hoja.id)));
      const tag = document.createElement('span');
      tag.className = 'sheet-tag';
      tag.textContent = `HOJA ${idx + 1}`;
      sheet.append(tag, grid);

      const row = document.createElement('div');
      row.className = 'sheet-row';
      row.dataset.hoja = hoja.id;
      row.innerHTML = panelHoja(hoja, idx);
      row.insertBefore(sheet, row.firstChild);
      sheetsEl.append(row);
    });
    renderMonto();
  };
  // Transición suave en re-render (Chrome 111+); fallback síncrono sin ella.
  if (document.startViewTransition) {
    const t = document.startViewTransition(render);
    // Si se solapan dos renders, la anterior se "skipea" y su ready rechaza: inocuo.
    t.ready?.catch(() => {});
    t.finished?.catch(() => {});
  } else render();
}

// Aplica el re-render que quedó pospuesto por un drag en curso (ver renderHojas).
function soltarRenderPendiente() {
  if (!renderPendiente) return;
  renderPendiente = false;
  renderHojas();
}

/* ---------- Cola de procesamiento (placeholder) ---------- */
// sleep con Promise.withResolvers: cancelable por AbortSignal (Chrome 119+).
function sleep(ms, { signal } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  if (signal?.aborted) return Promise.reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
  return promise;
}

async function procesarCola() {
  if (state.colaEnProceso) return;
  state.colaEnProceso = true;
  for (const hoja of state.hojas) {
    for (const c of itemsDe(hoja)) {
      if (c.estado === 'pendiente') {
        c.estado = 'procesando';
        renderHojas();
        // Placeholder: aquí irá el pipeline OpenCV→OCR→LLM.
        await sleep(900);
        // Simular resultado: texto OCR ficticio y monto total.
        c.textoOcr = sanear(`FACTURA ${c.nombre}\nFecha: 12/08/2026\nTOTAL: US$ 1,234.56`);
        c.montoCents = 123456;
        c.estado = 'ok';
        renderHojas();
      }
    }
  }
  state.colaEnProceso = false;
}

/* ---------- Entrada ---------- */
// Agrega archivos: si hojaId se indica, rellena los primeros huecos de ESA hoja
// (y crea hojas nuevas al final si sobran); si no, usa la última hoja con hueco.
function agregarArchivos(files, hojaId = null) {
  const validos = Iterator.from(files).filter((f) => /^image\/(jpeg|png|webp|bmp|gif)$/i.test(f.type) || f.name.toLowerCase().endsWith('.pdf')).toArray();
  if (files.length > 0 && validos.length === 0) {
    showToast('Solo se aceptan imágenes (JPG, PNG, WEBP, BMP, GIF) o PDF. HEIC no soportado.');
  }
  const nuevas = validos.map((f) => {
    const id = ++seq;
    return {
      id, nombre: sanear(f.name), file: f,
      imgUrl: URL.createObjectURL(f), thumbUrl: null, textoOcr: '',
      montoCents: null, moneda: 'USD', estado: 'pendiente', posicion: 0,
    };
  });
  if (nuevas.length === 0) return;
  const recienIngresados = [...nuevas]; // llenar() vacía `nuevas` con shift()

  let hoja = hojaId ? hojaPorId(hojaId) : null;
  if (!hoja) {
    // Repartir empezando por la última hoja con hueco; crear hojas nuevas si hace falta
    hoja = state.hojas.find((h) => cuentaHoja(h) < layoutDe(h.layout).total) || state.hojas[state.hojas.length - 1] || crearHoja();
    if (!state.hojas.includes(hoja)) state.hojas.push(hoja);
  }
  function llenar(h, lista) {
    for (let j = 0; j < h.slots.length && lista.length; j++) {
      if (!h.slots[j]) h.slots[j] = lista.shift();
    }
  }
  llenar(hoja, nuevas);
  while (nuevas.length) {
    hoja = crearHoja(hoja.layout);
    state.hojas.push(hoja);
    llenar(hoja, nuevas);
  }
  renderHojas();
  procesarCola();

  // Miniaturas en segundo plano: la app queda usable de inmediato con el blob
  // original y cada casilla se actualiza sola cuando su thumb está lista.
  for (const item of recienIngresados) {
    if (!/^image\//i.test(item.file.type)) continue; // PDF: sin miniatura
    Promise.try(async () => {
      const url = await generarMiniatura(item.file);
      if (!url) return;
      if (!buscarSlot(item.id)) { URL.revokeObjectURL(url); return; } // lo quitaron mientras se generaba
      item.thumbUrl = url;
      const img = sheetsEl.querySelector(`.cell[data-id="${item.id}"] img`);
      if (img) img.src = url;
    });
  }
}

const abortCtrl = new AbortController();
const { signal } = abortCtrl;

dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); }, { signal });
fileInput.addEventListener('change', () => { agregarArchivos(fileInput.files); fileInput.value = ''; }, { signal });

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }, { signal });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'), { signal });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  agregarArchivos(e.dataTransfer.files);
}, { signal });

document.addEventListener('paste', (e) => {
  const files = Iterator.from(e.clipboardData?.items || []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean).toArray();
  if (files.length) agregarArchivos(files);
}, { signal });

/* ---------- Quitar / drag entre hojas ---------- */
function quitarComprobante(id) {
  for (const h of state.hojas) {
    const idx = h.slots.findIndex((c) => c && c.id === id);
    if (idx >= 0) {
      URL.revokeObjectURL(h.slots[idx].imgUrl);
      if (h.slots[idx].thumbUrl) URL.revokeObjectURL(h.slots[idx].thumbUrl);
      h.slots[idx] = null;
      break;
    }
  }
  // Limpiar hojas vacías (conservar al menos una)
  limpiarHojas();
  guardar();
  renderHojas();
}

// Evento delegado: un solo listener, switch por data-accion
sheetsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-accion]');
  if (!btn) return;
  const cell = btn.closest('.cell');
  const id = Number(cell?.dataset.id);
  switch (btn.dataset.accion) {
    case 'copiar-ocr': {
      const item = aplanar().find((c) => c.id === id);
      if (!item) return;
      if (!item.textoOcr) { showToast('Sin texto OCR para copiar.'); return; }
      Promise.try(() => navigator.clipboard.writeText(item.textoOcr));
      showToast('Texto OCR copiado.');
      return;
    }
    case 'quitar':
      quitarComprobante(id);
      return;
    case 'layout':
      cambiarLayoutHoja(btn.dataset.hoja, btn.dataset.layout);
      return;
    case 'apply-all':
      aplicarATodas(btn.dataset.hoja);
      return;
  }
}, { signal });

/* ---------- Arrastre de comprobantes (Pointer Events: mover/swap entre casillas y hojas) ---------- */
const canvasEl = document.querySelector('.canvas');
let pointerDrag = null; // { id, ghost, gw, gh, startX, startY, lastX, lastY, activo }
let scrollRaf = null;   // id del requestAnimationFrame de auto-scroll
let moveRaf = null;     // id del rAF que agrupa hit-test/auto-scroll a 1 por frame
let celdaResaltada = null;
let rectsCache = null;  // rects de celdas congelados durante el drag (Map nodo->rect)
let renderPendiente = false; // re-render pedido por trabajo asíncrono durante un drag

function detenerScroll() {
  if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
}

function cancelarDragVisual() {
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
  // Cualquier selección de texto residual (arrastres nacidos fuera de una celda): limpiar
  const sel = window.getSelection();
  if (sel?.rangeCount) sel.removeAllRanges();
}

// Loop de auto-scroll con requestAnimationFrame (más fluido que setInterval)
function autoScroll(x, y) {
  if (!canvasEl) return;
  const r = canvasEl.getBoundingClientRect();
  const margen = 70, vel = 14;
  const dir = y < r.top + margen ? -vel : y > r.bottom - margen ? vel : 0;
  if (dir && scrollRaf === null) {
    const paso = () => {
      canvasEl.scrollBy({ top: dir });
      if (dir && scrollRaf !== null) scrollRaf = requestAnimationFrame(paso);
    };
    scrollRaf = requestAnimationFrame(paso);
  } else if (!dir) {
    detenerScroll();
  }
}

function esDragDeArchivos(e) {
  return Iterator.from(e.dataTransfer?.types || []).includes('Files');
}

// Rects de todas las celdas cacheados durante el drag: getBoundingClientRect solo
// se lee una vez por cambio real de layout (scroll del canvas), no por evento de
// puntero. Se invalida con el scroll; el resto del arrastre lee de memoria.
function celdaRect(c) {
  if (!rectsCache) {
    rectsCache = new Map();
    for (const el of sheetsEl.querySelectorAll('.cell')) rectsCache.set(el, el.getBoundingClientRect());
  }
  // Si la grilla cambió sin aviso (render pospuesto que corrió tarde, nodo nuevo),
  // se mide y se agrega a la cache en vez de leer un undefined.
  let r = rectsCache.get(c);
  if (!r) { r = c.getBoundingClientRect(); rectsCache.set(c, r); }
  return r;
}
canvasEl.addEventListener('scroll', () => { rectsCache = null; }, { passive: true, signal });

// Resuelve la celda destino bajo un punto: primero la que está exactamente bajo el
// cursor; si no (gap/padding de la grilla), la celda más cercana de la hoja más
// próxima (< 150px), excluyendo la celda origen (excluir) para no caer en un no-op.
function celdaBajoPunto(x, y, excluir) {
  const el = document.elementFromPoint(x, y);
  const directa = el?.closest?.('.cell');
  if (directa) return directa;
  const hoja = el?.closest?.('.sheet');
  const celulas = [...(hoja || sheetsEl).querySelectorAll('.cell')].filter((c) => c !== excluir);
  let mejor = null, mejorD = Infinity;
  for (const c of celulas) {
    const r = celdaRect(c);
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d < mejorD) { mejorD = d; mejor = c; }
  }
  return mejorD < 150 ? mejor : null;
}

sheetsEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return;
  if (state.modoOcr) return; // vista de lectura/copia: sin arrastre
  const cell = e.target.closest('.cell');
  if (!cell || cell.classList.contains('empty')) return;
  if (e.target.closest('[data-accion="quitar"]')) return; // el × no inicia drag
  e.preventDefault();
  if (pointerDrag) { // drag anterior sin cerrar (pointerup perdido): finalizar antes de abrir otro
    pointerDrag = null;
    cancelarDragVisual();
  }
  pointerDrag = {
    id: Number(cell.dataset.id),
    ghost: null, gw: 0, gh: 0,
    startX: e.clientX, startY: e.clientY,
    lastX: e.clientX, lastY: e.clientY,
    activo: false,
  };
  cell.closest('.sheet-grid').classList.add('dragging');
  try { sheetsEl.setPointerCapture(e.pointerId); } catch { /* puntero ya inactivo */ } // garantiza pointerup aunque se suelte fuera de la ventana
}, { signal });

function iniciarGhost(d, x, y) {
  if (d.ghost) return;
  // Buscar la imagen actual en el DOM (el render puede recrear el nodo durante el drag)
  const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${d.id}"]`);
  const img = celdaOrigen?.querySelector('img');
  if (!img) return;
  const r = img.getBoundingClientRect();
  const base = r.width > 2 ? r : celdaOrigen.getBoundingClientRect(); // imagen aún sin decodificar/layout
  const ghost = img.cloneNode(true);
  ghost.className = 'drag-ghost';
  ghost.style.width = base.width + 'px';
  ghost.style.height = base.height + 'px';
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.gw = base.width / 2;
  d.gh = base.height / 2;
  d.activo = true;
  celdaOrigen.classList.add('pickup');
  document.body.classList.add('is-dragging');
  posicionarGhost(d, x, y);
}

// El ghost se mueve solo con transform (capa de compositor): lecturas de layout cero.
function posicionarGhost(d, x, y) {
  if (!d.ghost) return;
  d.ghost.style.transform = `translate(${x - d.gw}px, ${y - d.gh}px) rotate(1.5deg) scale(1.04)`;
}

function resaltarDestino(cell) {
  if (cell && cell.dataset.id === String(pointerDrag?.id)) cell = null; // el origen nunca es destino
  if (cell === celdaResaltada) return; // evitar mutar clases cada frame si no cambió
  if (celdaResaltada) celdaResaltada.classList.remove('drop-target');
  celdaResaltada = null;
  if (cell && sheetsEl.contains(cell)) {
    cell.classList.add('drop-target');
    celdaResaltada = cell;
  }
}

document.addEventListener('pointermove', (e) => {
  if (!pointerDrag) return;
  if (!pointerDrag.activo) {
    const d = Math.hypot(e.clientX - pointerDrag.startX, e.clientY - pointerDrag.startY);
    if (d <= 5) return;
    iniciarGhost(pointerDrag, e.clientX, e.clientY);
    if (!pointerDrag?.activo) return;
  }
  pointerDrag.lastX = e.clientX;
  pointerDrag.lastY = e.clientY;
  posicionarGhost(pointerDrag, e.clientX, e.clientY); // escritura pura: cero lag del ghost
  if (moveRaf !== null) return;
  moveRaf = requestAnimationFrame(() => { // auto-scroll + hit-test: como máximo 1 por frame
    moveRaf = null;
    const drag = pointerDrag;
    if (!drag) return;
    autoScroll(drag.lastX, drag.lastY);
    const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${drag.id}"]`);
    resaltarDestino(celdaBajoPunto(drag.lastX, drag.lastY, celdaOrigen));
  });
}, { signal });

// Único camino de cierre del drag (pointerup y red de seguridad de capture).
function finalizarDrag(x, y) {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  const fueActivo = drag.activo;
  const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${drag.id}"]`);
  pointerDrag = null;
  cancelarDragVisual();
  soltarRenderPendiente(); // aplicar re-renders de la cola pospuestos durante el arrastre
  if (!fueActivo) return; // fue un clic
  const cell = celdaBajoPunto(x, y, celdaOrigen);
  if (!cell) return;
  const hojaDestino = hojaPorId(Number(cell.closest('.sheet').dataset.hoja));
  const slotDestino = Number(cell.dataset.slot);
  if (!hojaDestino || !Number.isInteger(slotDestino)) return;
  moverSlot(drag, hojaDestino, slotDestino, { x, y });
}

document.addEventListener('pointerup', (e) => finalizarDrag(e.clientX, e.clientY), { signal });

// Red de seguridad: si la captura se pierde sin haber recibido pointerup (gesto del
// sistema, pérdida de foco), se suelta el drag con la última coordenada conocida.
// Es posterior al pointerup natural, cuando ya no queda drag que cerrar.
sheetsEl.addEventListener('lostpointercapture', (e) => {
  if (!e.isPrimary || !pointerDrag) return;
  finalizarDrag(pointerDrag.lastX, pointerDrag.lastY);
}, { signal });

document.addEventListener('pointercancel', () => {
  if (!pointerDrag) return;
  pointerDrag = null;
  cancelarDragVisual();
  soltarRenderPendiente();
}, { signal });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pointerDrag) {
    pointerDrag = null;
    cancelarDragVisual();
    soltarRenderPendiente();
  }
}, { signal });

// Drag de archivos del explorador: se mantiene con el drag nativo (DataTransfer)
sheetsEl.addEventListener('dragover', (e) => {
  if (!esDragDeArchivos(e)) return;
  if (state.modoOcr) return;
  e.preventDefault();
  autoScroll(e.clientX, e.clientY);
  const sheet = e.target.closest('.sheet');
  sheetsEl.querySelectorAll('.sheet.file-drop').forEach((s) => { if (s !== sheet) s.classList.remove('file-drop'); });
  if (sheet) sheet.classList.add('file-drop');
}, { signal });

sheetsEl.addEventListener('dragleave', (e) => {
  if (!esDragDeArchivos(e)) return;
  const sheet = e.target.closest('.sheet');
  if (sheet && !sheet.contains(e.relatedTarget)) sheet.classList.remove('file-drop');
}, { signal });

sheetsEl.addEventListener('drop', (e) => {
  if (!esDragDeArchivos(e)) return;
  e.preventDefault();
  if (state.modoOcr) return; // vista de lectura/copia: no se sueltan archivos
  const sheet = e.target.closest('.sheet');
  cancelarDragVisual();
  if (sheet) agregarArchivos(e.dataTransfer.files, Number(sheet.dataset.hoja));
  else showToast('Soltá archivos sobre una hoja para agregarlos.');
}, { signal });

// FLIP "Play": hace volar `img` desde un centro aparente hasta su posición real.
// Solo usa transform (Web Animations): sin limpieza de estilos, sin VT, y el área
// de clic del navegador sigue a la imagen animada (what-you-see-is-what-you-grab).
function animarFlipDesde(img, cx, cy) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = img.getBoundingClientRect();
  if (r.width < 2) return; // todavía sin layout
  const dx = cx - (r.left + r.width / 2);
  const dy = cy - (r.top + r.height / 2);
  if (Math.hypot(dx, dy) < 2) return;
  img.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
    { duration: 170, easing: 'cubic-bezier(.2, .8, .2, 1)' },
  );
}

function actualizarConteoPanel(hoja) {
  const span = sheetsEl.querySelector(`.sheet-row[data-hoja="${hoja.id}"] .sheet-panel-count`);
  if (span) span.textContent = `${cuentaHoja(hoja)}/${layoutDe(hoja.layout).total}`;
}

// Mueve (o intercambia, si el destino está ocupado) el comprobante al slot pedido.
// Repinta solo las 2 casillas afectadas (pintarCelda) + animación FLIP: no hay
// re-render total ni View Transition en este camino, que era lo que dejaba el DOM
// desacompasado de lo visible y hacía que el siguiente pointerdown marcara el monto.
function moverSlot(drag, hojaDestino, slotDestino, centroA) {
  const actual = buscarSlot(drag.id); // revalidar posición real por id (pudo moverse entre down y up)
  if (!actual) return;
  const { hoja: origen, idx: idxOrigen } = actual;
  if (origen === hojaDestino && idxOrigen === slotDestino) return; // misma casilla: no-op

  // FLIP "First": centro actual de la imagen desplazada (antes de repintar)
  const ocupante = hojaDestino.slots[slotDestino];
  const imgB = ocupante ? sheetsEl.querySelector(`.cell[data-id="${ocupante.id}"] img`) : null;
  const rB = imgB?.getBoundingClientRect();

  const idsHojasAntes = state.hojas.map((h) => h.id).join();
  const reemplazo = hojaDestino.slots[slotDestino] || null;
  hojaDestino.slots[slotDestino] = origen.slots[idxOrigen];
  origen.slots[idxOrigen] = reemplazo;
  limpiarHojas();
  guardar();

  // Si la operación cambió la estructura de hojas (origen vaciada y eliminada),
  // el parcheo local no alcanza: fallback a render completo (poco frecuente).
  const estructural = state.hojas.map((h) => h.id).join() !== idsHojasAntes;
  const nodoOrigen = sheetsEl.querySelector(`.sheet[data-hoja="${origen.id}"] .cell[data-slot="${idxOrigen}"]`);
  const nodoDestino = sheetsEl.querySelector(`.sheet[data-hoja="${hojaDestino.id}"] .cell[data-slot="${slotDestino}"]`);
  if (estructural || !nodoOrigen || !nodoDestino) { renderHojas(); return; }

  pintarCelda(nodoOrigen, origen.slots[idxOrigen], idxOrigen, origen.id);
  pintarCelda(nodoDestino, hojaDestino.slots[slotDestino], slotDestino, hojaDestino.id);

  // A vuela desde el punto de soltura (handoff perfecto con el ghost);
  // B vuela desde la casilla que ocupaba hacia la casilla origen.
  const imgA = nodoDestino.querySelector('img');
  if (imgA && centroA) animarFlipDesde(imgA, centroA.x, centroA.y);
  const imgBDestino = nodoOrigen.querySelector('img');
  if (imgBDestino && rB) animarFlipDesde(imgBDestino, rB.left + rB.width / 2, rB.top + rB.height / 2);

  actualizarConteoPanel(origen);
  if (hojaDestino !== origen) actualizarConteoPanel(hojaDestino);
  renderMonto();
}

/* ---------- Código de pedido ---------- */
chkCodigo.addEventListener('change', () => { state.codigoActivo = chkCodigo.checked; guardar(); renderCodigo(); }, { signal });
numCodigo.addEventListener('input', () => {
  state.codigoLongitud = Math.max(1, Math.min(12, Number(numCodigo.value) || 6));
  guardar(); renderCodigo();
}, { signal });
inputCodigo.addEventListener('input', () => {
  state.codigoValor = inputCodigo.value.replace(/\D/g, '').slice(0, state.codigoLongitud);
  inputCodigo.value = state.codigoValor;
  guardar();
}, { signal });

function renderCodigo() {
  chkCodigo.checked = state.codigoActivo;
  numCodigo.value = state.codigoLongitud;
  inputCodigo.value = state.codigoValor;
  inputCodigo.maxLength = state.codigoLongitud;
  inputCodigo.disabled = !state.codigoActivo;
  inputCodigo.placeholder = state.codigoActivo ? `Código (${state.codigoLongitud} dígitos)` : 'Código';
}

function codigoValido() {
  if (!state.codigoActivo) return true;
  return new RegExp(`^\\d{${state.codigoLongitud}}$`).test(state.codigoValor);
}

/* ---------- Descargar Word (stub) ---------- */
async function descargarWord() {
  if (!codigoValido()) {
    showToast(`Código de pedido inválido: se requieren ${state.codigoLongitud} dígitos.`);
    return;
  }
  if (totalItems() === 0) { showToast('No hay comprobantes para descargar.'); return; }
  showToast('Generando .docx… (esqueleto)');

  // Stub: armar un blob de texto simple (en la implementación real usa docx.js)
  const contenido = [
    'DOCX STUB — Cortar y Ordenar Facturas',
    `Código de pedido: ${state.codigoActivo ? state.codigoValor : '(sin código)'}`,
    `Hojas: ${state.hojas.length}`,
    ...aplanar().map((c) => `- ${c.nombre}: ${formatearMoneda(c.montoCents || 0)}`),
  ].join('\n');
  const blob = new Blob([contenido], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const cod = state.codigoActivo ? state.codigoValor : 'sincodigo';
  a.download = `${cod}-comprobante.docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast('Descarga iniciada (esqueleto).');
}
btnDescargar2.addEventListener('click', descargarWord, { signal });

/* ---------- Modo OCR (toggle global sobre las hojas) ---------- */
const chkOcr = $('chkOcr');
const ocrEstado = $('ocrEstado');

function renderOcrToggle() {
  chkOcr.checked = state.modoOcr;
  ocrEstado.textContent = state.modoOcr ? 'ON' : 'OFF';
  ocrEstado.classList.toggle('on', state.modoOcr);
}

function toggleModoOcr() {
  state.modoOcr = !state.modoOcr;
  renderOcrToggle();
  renderHojas();
}

chkOcr.addEventListener('change', () => {
  if (chkOcr.checked !== state.modoOcr) toggleModoOcr();
}, { signal });

/* ---------- Modal Ajustes ---------- */
const modalAjustes = $('modalAjustes');
btnAjustes.addEventListener('click', () => {
  $('cfgBaseUrl').value = state.configIA.baseUrl;
  $('cfgModel').value = state.configIA.model;
  $('cfgApiKey').value = state.configIA.apiKey;
  $('cfgMoneda').value = state.moneda;
  modalAjustes.showModal();
}, { signal });
$('formAjustes').addEventListener('submit', () => {
  state.configIA.baseUrl = $('cfgBaseUrl').value || 'https://api.openai.com/v1';
  state.configIA.model = $('cfgModel').value || 'gpt-4o-mini';
  state.configIA.apiKey = $('cfgApiKey').value;
  state.moneda = $('cfgMoneda').value;
  guardar();
  renderMonto();
  renderHojas();
  showToast('Ajustes guardados.');
}, { signal });

/* ---------- Limpiar ---------- */
btnLimpiar.addEventListener('click', () => {
  for (const h of state.hojas) for (const c of itemsDe(h)) {
    URL.revokeObjectURL(c.imgUrl);
    if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
  }
  state.hojas = [crearHoja()];
  guardar();
  renderHojas();
  showToast('Lote limpiado. Se conservan check y ajustes.');
}, { signal });

/* ---------- Toast ---------- */
let toastCtrl = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  toastCtrl?.abort();
  toastCtrl = new AbortController();
  sleep(2600, { signal: toastCtrl.signal }).then(() => { t.hidden = true; });
}

/* ---------- Tema claro/oscuro ---------- */
const TEMA_KEY = 'libro-mayor-tema';
function temaActual() {
  return document.documentElement.dataset.tema === 'claro' ? 'claro' : 'oscuro';
}
function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  temaIcono.textContent = tema === 'claro' ? '☀' : '☾';
  btnTema.title = tema === 'claro' ? 'Cambiar a oscuro' : 'Cambiar a claro';
}
function initTema() {
  let tema = localStorage.getItem(TEMA_KEY);
  if (!tema) {
    // Default: seguir preferencia del sistema; si no, oscuro (actual).
    const pref = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'oscuro';
    tema = pref;
  }
  aplicarTema(tema);
}
btnTema.addEventListener('click', () => {
  const nuevo = temaActual() === 'claro' ? 'oscuro' : 'claro';
  localStorage.setItem(TEMA_KEY, nuevo);
  aplicarTema(nuevo);
}, { signal });

/* ---------- Init ---------- */
cargar();
state.hojas = state.hojas.length ? state.hojas : [crearHoja()];
renderCodigo();
renderHojas();
renderOcrToggle();
initTema();
