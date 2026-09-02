/* ============================================================
   CORTAR Y ORDENAR FACTURAS — app.js (esqueleto funcional)
   Diseño 1 · Libro Mayor
   ------------------------------------------------------------------
   Este esqueléto maneja el estado mínimo del flujo:
   - entrada (dropzone / pegar / subir)
   - cola secuencial de procesamiento (placeholder para OpenCV+OCR)
   - monto acumulado en cents (suma exacta)
   - hojas independientes con N propio (1-6) vía popover flotante
   - código de pedido persistente, modal OCR y ajustes
   - export .docx (stub que arma un Blob)
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Estado global ---------- */
  const state = {
    hojas: [],             // [{id, layout, slots:[comprobante|null...]}] — una casilla fija por posición de la plantilla
    codigoActivo: false,
    codigoLongitud: 6,
    codigoValor: '',
    configIA: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
    moneda: 'USD',
    colaEnProceso: false,
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
  const btnOcr = $('btnOcr');
  const btnLimpiar = $('btnLimpiar');
  const btnDescargar2 = $('btnDescargar2');
  const btnAjustes = $('btnAjustes');
  const btnTema = $('btnTema');
  const temaIcono = $('temaIcono');

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
      state.codigoActivo = p.codigoActivo ?? false;
      state.codigoLongitud = p.codigoLongitud ?? 6;
      state.codigoValor = p.codigoValor ?? '';
      state.moneda = p.moneda ?? 'USD';
      state.configIA = { ...state.configIA, ...(p.configIA || {}) };
    } catch { /* estado corrupto: ignorar */ }
  }

  /* ---------- Monetario ---------- */
  function formatearMoneda(cents) {
    const m = MONEDAS[state.moneda] || MONEDAS.USD;
    return `${m.simbolo} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function sumaTotal() {
    return state.hojas.reduce((acc, h) => acc + itemsDe(h).reduce((a, c) => a + (c.montoCents || 0), 0), 0);
  }

  function renderMonto() {
    montoEl.textContent = formatearMoneda(sumaTotal());
  }

  function totalItems() {
    return state.hojas.reduce((acc, h) => acc + itemsDe(h).length, 0);
  }

  function itemsDe(hoja) { return hoja.slots.filter(Boolean); }
  function cuentaHoja(hoja) { return itemsDe(hoja).length; }

  // Orden visual global (por slots, huecos ignorados)
  function aplanar() {
    return state.hojas.flatMap((h) => itemsDe(h));
  }

  function crearHoja(layoutId = 'u4x2') {
    const l = layoutDe(layoutId);
    return { id: ++seqHoja, layout: l.id, slots: Array(l.total).fill(null) };
  }

  function hojaPorId(id) {
    return state.hojas.find((h) => h.id === Number(id));
  }

  function limpiarHojas() {
    state.hojas = state.hojas.filter((h) => h.slots.some(Boolean));
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

  function celda(item, pos, slotIdx, hojaId) {
    const estilo = pos ? `grid-row: ${pos[0]}; grid-column: ${pos[1]} / span ${pos[2]};` : '';
    if (!item) {
      return `<div class="cell empty" data-slot="${slotIdx}" data-hoja="${hojaId}" style="${estilo}">Vacío</div>`;
    }
    const badge = item.montoCents != null ? `<span class="cell-badge">${formatearMoneda(item.montoCents)}</span>` : '';
    return `
      <div class="cell cell-${item.estado}" data-id="${item.id}" data-slot="${slotIdx}" data-hoja="${hojaId}" style="${estilo}">
        <img src="${item.imgUrl}" alt="${item.nombre}" draggable="false" loading="lazy" decoding="async" />
        <button class="cell-remove" data-accion="quitar" title="Quitar">×</button>
        ${badge}
      </div>`;
  }

  function panelHoja(hoja, idx) {
    const tarjetas = ORDEN_PLANTILLAS.map((id) => {
      const l = PLANTILLAS[id];
      const fichas = l.pos.map(([f, c, s]) => `<span class="ficha" style="grid-row:${f};grid-column:${c} / span ${s};"></span>`).join('');
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
    metaHojas.textContent = `${state.hojas.length} hoja${state.hojas.length === 1 ? '' : 's'} · ${totalItems()} comprobante${totalItems() === 1 ? '' : 's'}`;
    sheetsEl.innerHTML = '';

    if (totalItems() === 0) {
      sheetsEl.innerHTML = `
        <div class="empty-state">
          <h2>Comenzá pegando tus comprobantes</h2>
          <p>Usá <strong>Ctrl+V</strong>, arrastrá imágenes o hacé clic en el cuadro de entrada. Cada comprobante se recorta, se lee su texto y se suma su total.</p>
        </div>`;
      return;
    }

    state.hojas.forEach((hoja, idx) => {
      const l = layoutDe(hoja.layout);
      const sheet = document.createElement('article');
      sheet.className = 'sheet';
      sheet.dataset.hoja = hoja.id;
      sheet.innerHTML = `
        <span class="sheet-tag">HOJA ${idx + 1}</span>
        <div class="sheet-grid" style="grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)">
          ${l.pos.map((p, i) => celda(hoja.slots[i], p, i, hoja.id)).join('')}
        </div>`;
      const row = document.createElement('div');
      row.className = 'sheet-row';
      row.dataset.hoja = hoja.id;
      row.innerHTML = panelHoja(hoja, idx);
      row.insertBefore(sheet, row.firstChild);
      sheetsEl.appendChild(row);
    });
    renderMonto();
  }

  /* ---------- Cola de procesamiento (placeholder) ---------- */
  async function procesarCola() {
    if (state.colaEnProceso) return;
    state.colaEnProceso = true;
    for (const hoja of state.hojas) {
      for (const c of itemsDe(hoja)) {
        if (c.estado === 'pendiente') {
          c.estado = 'procesando';
          renderHojas();
          // Placeholder: aquí irá el pipeline OpenCV→OCR→LLM.
          await new Promise((r) => setTimeout(r, 900));
          // Simular resultado: texto OCR ficticio y monto total.
          c.textoOcr = `FACTURA ${c.nombre}\nFecha: 12/08/2026\nTOTAL: US$ 1,234.56`;
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
    const validos = Array.from(files).filter((f) => /^image\/(jpeg|png|webp|bmp|gif)$/.test(f.type) || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0 && validos.length === 0) {
      showToast('Solo se aceptan imágenes (JPG, PNG, WEBP, BMP, GIF) o PDF. HEIC no soportado.');
    }
    const nuevas = validos.map((f) => {
      const id = ++seq;
      return {
        id, nombre: f.name, imgUrl: URL.createObjectURL(f), textoOcr: '',
        montoCents: null, moneda: 'USD', estado: 'pendiente', posicion: 0,
      };
    });
    if (nuevas.length === 0) return;

    let hoja = hojaId ? hojaPorId(hojaId) : null;
    if (!hoja) {
      // Repartir empezando por la última hoja con hueco; crear hojas nuevas si hace falta
      hoja = state.hojas.find((h) => cuentaHoja(h) < layoutDe(h.layout).total) || state.hojas[state.hojas.length - 1] || crearHoja();
      if (!state.hojas.includes(hoja)) state.hojas.push(hoja);
    }
    function llenar(h, lista) {
      for (let i = 0; i < h.slots.length && lista.length; i++) {
        if (!h.slots[i]) h.slots[i] = lista.shift();
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
  }

  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => { agregarArchivos(fileInput.files); fileInput.value = ''; });

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    agregarArchivos(e.dataTransfer.files);
  });

  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) agregarArchivos(files);
  });

  /* ---------- Quitar / drag entre hojas ---------- */
  function quitarComprobante(id) {
    for (const h of state.hojas) {
      const idx = h.slots.findIndex((c) => c && c.id === id);
      if (idx >= 0) {
        URL.revokeObjectURL(h.slots[idx].imgUrl);
        h.slots[idx] = null;
        break;
      }
    }
    // Limpiar hojas vacías (conservar al menos una)
    limpiarHojas();
    guardar();
    renderHojas();
  }

  sheetsEl.addEventListener('click', (e) => {
    const btnQuitar = e.target.closest('[data-accion="quitar"]');
    if (btnQuitar) {
      quitarComprobante(Number(btnQuitar.closest('.cell').dataset.id));
      return;
    }
    const btnLayout = e.target.closest('[data-accion="layout"]');
    if (btnLayout) {
      cambiarLayoutHoja(btnLayout.dataset.hoja, btnLayout.dataset.layout);
      return;
    }
    const btnApply = e.target.closest('[data-accion="apply-all"]');
    if (btnApply) {
      aplicarATodas(btnApply.dataset.hoja);
    }
  });

  /* ---------- Arrastre de comprobantes (Pointer Events: mover/swap entre casillas y hojas) ---------- */
  const canvasEl = document.querySelector('.canvas');
  let pointerDrag = null; // { id, hojaId, slotIdx, img, ghost, startX, startY, activo }
  let scrollTimer = null;

  function detenerScroll() {
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
  }

  function cancelarDragVisual() {
    sheetsEl.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    sheetsEl.querySelectorAll('.sheet-grid.dragging').forEach((g) => g.classList.remove('dragging'));
    sheetsEl.querySelectorAll('.sheet.file-drop').forEach((s) => s.classList.remove('file-drop'));
    sheetsEl.querySelectorAll('.cell.pickup').forEach((c) => c.classList.remove('pickup'));
    document.querySelectorAll('.drag-ghost').forEach((g) => g.remove());
    detenerScroll();
  }

  function autoScroll(e) {
    if (!canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    const margen = 70, vel = 14;
    const dir = e.clientY < r.top + margen ? -vel : e.clientY > r.bottom - margen ? vel : 0;
    if (dir && !scrollTimer) {
      scrollTimer = setInterval(() => canvasEl.scrollBy({ top: dir }), 16);
    } else if (!dir && scrollTimer) {
      detenerScroll();
    }
  }

  function esDragDeArchivos(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  }

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
      const r = c.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < mejorD) { mejorD = d; mejor = c; }
    }
    return mejorD < 150 ? mejor : null;
  }

  sheetsEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const cell = e.target.closest('.cell');
    if (!cell || cell.classList.contains('empty')) return;
    if (e.target.closest('[data-accion="quitar"]')) return; // el × no inicia drag
    e.preventDefault();
    pointerDrag = {
      id: Number(cell.dataset.id),
      hojaId: Number(cell.closest('.sheet').dataset.hoja),
      slotIdx: Number(cell.dataset.slot),
      ghost: null,
      startX: e.clientX, startY: e.clientY,
      activo: false,
    };
    cell.closest('.sheet-grid').classList.add('dragging');
  });

  function iniciarGhost(pointerDrag) {
    if (pointerDrag.ghost) return;
    // Buscar la imagen actual en el DOM (el render puede recrear el nodo durante el drag)
    const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${pointerDrag.id}"]`);
    const img = celdaOrigen?.querySelector('img');
    if (!img) return;
    const r = img.getBoundingClientRect();
    const ghost = img.cloneNode(true);
    ghost.className = 'drag-ghost';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    pointerDrag.ghost = ghost;
    celdaOrigen.classList.add('pickup');
    pointerDrag.activo = true;
  }

  function moverGhost(pointerDrag, x, y) {
    if (!pointerDrag.ghost) return;
    const r = pointerDrag.ghost.getBoundingClientRect();
    pointerDrag.ghost.style.left = (x - r.width / 2) + 'px';
    pointerDrag.ghost.style.top = (y - r.height / 2) + 'px';
  }

  function resaltarDestino(cell) {
    sheetsEl.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    if (cell) {
      const misma = cell.dataset.id === String(pointerDrag?.id);
      if (!misma) cell.classList.add('drop-target');
    }
  }

  document.addEventListener('pointermove', (e) => {
    if (!pointerDrag) return;
    if (!pointerDrag.activo) {
      const d = Math.hypot(e.clientX - pointerDrag.startX, e.clientY - pointerDrag.startY);
      if (d > 5) iniciarGhost(pointerDrag);
      else return;
    }
    moverGhost(pointerDrag, e.clientX, e.clientY);
    autoScroll(e);
    const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${pointerDrag.id}"]`);
    resaltarDestino(celdaBajoPunto(e.clientX, e.clientY, celdaOrigen));
  });

  document.addEventListener('pointerup', (e) => {
    if (!pointerDrag) return;
    const drag = pointerDrag;
    const fueActivo = drag.activo;
    const celdaOrigen = sheetsEl.querySelector(`.cell[data-id="${drag.id}"]`);
    pointerDrag = null;
    cancelarDragVisual();
    if (!fueActivo) return; // fue un clic
    const cell = celdaBajoPunto(e.clientX, e.clientY, celdaOrigen);
    if (!cell) return;
    const hojaDestino = hojaPorId(Number(cell.closest('.sheet').dataset.hoja));
    const slotDestino = Number(cell.dataset.slot);
    if (!hojaDestino || !Number.isInteger(slotDestino)) return;
    moverSlot(drag, hojaDestino, slotDestino);
  });

  document.addEventListener('pointercancel', () => {
    pointerDrag = null;
    cancelarDragVisual();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pointerDrag) {
      pointerDrag = null;
      cancelarDragVisual();
    }
  });

  // Drag de archivos del explorador: se mantiene con el drag nativo (DataTransfer)
  sheetsEl.addEventListener('dragover', (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    autoScroll(e);
    const sheet = e.target.closest('.sheet');
    sheetsEl.querySelectorAll('.sheet.file-drop').forEach((s) => { if (s !== sheet) s.classList.remove('file-drop'); });
    if (sheet) sheet.classList.add('file-drop');
  });

  sheetsEl.addEventListener('dragleave', (e) => {
    if (!esDragDeArchivos(e)) return;
    const sheet = e.target.closest('.sheet');
    if (sheet && !sheet.contains(e.relatedTarget)) sheet.classList.remove('file-drop');
  });

  sheetsEl.addEventListener('drop', (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    const sheet = e.target.closest('.sheet');
    cancelarDragVisual();
    if (sheet) agregarArchivos(e.dataTransfer.files, Number(sheet.dataset.hoja));
    else showToast('Soltá archivos sobre una hoja para agregarlos.');
  });

  // Mueve (o intercambia, si el destino está ocupado) el comprobante al slot pedido.
  function moverSlot(drag, hojaDestino, slotDestino) {
    const origen = hojaPorId(drag.hojaId);
    if (!origen) return;
    const item = origen.slots[drag.slotIdx];
    if (!item) return;
    if (origen === hojaDestino && drag.slotIdx === slotDestino) return; // misma casilla: no-op
    const reemplazo = hojaDestino.slots[slotDestino] || null;
    hojaDestino.slots[slotDestino] = item;
    origen.slots[drag.slotIdx] = reemplazo;
    limpiarHojas();
    guardar();
    renderHojas();
  }

  /* ---------- Código de pedido ---------- */
  chkCodigo.addEventListener('change', () => { state.codigoActivo = chkCodigo.checked; guardar(); renderCodigo(); });
  numCodigo.addEventListener('input', () => {
    state.codigoLongitud = Math.max(1, Math.min(12, Number(numCodigo.value) || 6));
    guardar(); renderCodigo();
  });
  inputCodigo.addEventListener('input', () => {
    state.codigoValor = inputCodigo.value.replace(/\D/g, '').slice(0, state.codigoLongitud);
    inputCodigo.value = state.codigoValor;
    guardar();
  });

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
  btnDescargar2.addEventListener('click', descargarWord);

  /* ---------- Modal OCR ---------- */
  const modalOcr = $('modalOcr');
  const selOcr = $('selOcr');
  const ocrTexto = $('ocrTexto');
  btnOcr.addEventListener('click', () => {
    if (totalItems() === 0) { showToast('No hay comprobantes todavía.'); return; }
    const todos = aplanar();
    selOcr.innerHTML = todos.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('');
    selOcr.dispatchEvent(new Event('change'));
    modalOcr.showModal();
  });
  selOcr.addEventListener('change', () => {
    const todos = aplanar();
    const c = todos.find((x) => x.id === Number(selOcr.value));
    ocrTexto.textContent = c?.textoOcr || '(sin texto OCR)';
  });
  $('btnCopiarOcr').addEventListener('click', () => {
    navigator.clipboard.writeText(ocrTexto.textContent);
    showToast('Texto OCR copiado.');
  });

  /* ---------- Modal Ajustes ---------- */
  const modalAjustes = $('modalAjustes');
  btnAjustes.addEventListener('click', () => {
    $('cfgBaseUrl').value = state.configIA.baseUrl;
    $('cfgModel').value = state.configIA.model;
    $('cfgApiKey').value = state.configIA.apiKey;
    $('cfgMoneda').value = state.moneda;
    modalAjustes.showModal();
  });
  $('formAjustes').addEventListener('submit', () => {
    state.configIA.baseUrl = $('cfgBaseUrl').value || 'https://api.openai.com/v1';
    state.configIA.model = $('cfgModel').value || 'gpt-4o-mini';
    state.configIA.apiKey = $('cfgApiKey').value;
    state.moneda = $('cfgMoneda').value;
    guardar();
    renderMonto();
    renderHojas();
    showToast('Ajustes guardados.');
  });

  /* ---------- Limpiar ---------- */
  btnLimpiar.addEventListener('click', () => {
    for (const h of state.hojas) for (const c of itemsDe(h)) URL.revokeObjectURL(c.imgUrl);
    state.hojas = [crearHoja()];
    guardar();
    renderHojas();
    showToast('Lote limpiado. Se conservan check y ajustes.');
  });

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
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
  });

  /* ---------- Init ---------- */
  cargar();
  state.hojas = state.hojas.length ? state.hojas : [crearHoja()];
  renderCodigo();
  renderHojas();
  initTema();
})();
