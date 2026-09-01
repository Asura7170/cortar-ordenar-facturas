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
    hojas: [],             // [{id, nup, items:[comprobante...]}] — cada hoja con su N (se inicia en el init)
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
    return state.hojas.reduce((acc, h) => acc + h.items.reduce((a, c) => a + (c.montoCents || 0), 0), 0);
  }

  function renderMonto() {
    montoEl.textContent = formatearMoneda(sumaTotal());
  }

  function totalItems() {
    return state.hojas.reduce((acc, h) => acc + h.items.length, 0);
  }

  function crearHoja(layoutId = 'u4x2') {
    return { id: ++seqHoja, layout: layoutDe(layoutId).id || layoutId, items: [] };
  }

  function hojaPorId(id) {
    return state.hojas.find((h) => h.id === Number(id));
  }

  function limpiarHojas() {
    state.hojas = state.hojas.filter((h) => h.items.length > 0);
    if (state.hojas.length === 0) state.hojas.push(crearHoja());
  }

  // Reparte todos los comprobantes en orden global respetando la capacidad de cada hoja:
  // llena hojas hacia la izquierda (al subir N una hoja atrae items de las siguientes)
  // y empuja excedentes hacia adelante (al bajar N). Crea hojas al final si sobran.
  function redistribuir() {
    const items = state.hojas.flatMap((h) => h.items);
    let pos = 0;
    for (const h of state.hojas) {
      const cap = layoutDe(h.layout).total;
      h.items = items.slice(pos, pos + cap);
      pos += cap;
    }
    while (pos < items.length) {
      const h = crearHoja(state.hojas[state.hojas.length - 1].layout);
      const cap = layoutDe(h.layout).total;
      h.items = items.slice(pos, pos + cap);
      pos += cap;
      state.hojas.push(h);
    }
    limpiarHojas();
  }

  // Mueve el excedente de una hoja (cuando items > capacidad) a las siguientes con espacio,
  // creando hojas al final si hace falta. Preserva el orden de los comprobantes.
  function reflowExceso(desdeIdx) {
    let extra = [];
    for (let i = desdeIdx; i < state.hojas.length; i++) {
      const h = state.hojas[i];
      const cap = layoutDe(h.layout).total;
      while (extra.length && h.items.length < cap) {
        h.items.push(extra.shift());
      }
      if (h.items.length > cap) {
        // El excedente previo (anterior en el orden global) va primero
        extra = extra.concat(h.items.splice(cap, h.items.length - cap));
      }
    }
    while (extra.length) {
      const h = crearHoja(state.hojas[state.hojas.length - 1].layout);
      const cap = layoutDe(h.layout).total;
      while (h.items.length < cap && extra.length) {
        h.items.push(extra.shift());
      }
      state.hojas.push(h);
    }
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

  function celda(c, pos) {
    const badge = c.montoCents != null ? `<span class="cell-badge">${formatearMoneda(c.montoCents)}</span>` : '';
    const estilo = pos ? `grid-row: ${pos[0]}; grid-column: ${pos[1]} / span ${pos[2]};` : '';
    return `
      <div class="cell cell-${c.estado}" data-id="${c.id}" style="${estilo}">
        <img src="${c.imgUrl}" alt="${c.nombre}" draggable="true" loading="lazy" decoding="async" />
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
          <span class="sheet-panel-count">${hoja.items.length}/${layoutDe(hoja.layout).total}</span>
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
      const posLibres = l.pos.slice(hoja.items.length);
      sheet.innerHTML = `
        <span class="sheet-tag">HOJA ${idx + 1}</span>
        <div class="sheet-grid" style="grid-template-columns: repeat(${l.cols}, 1fr); grid-template-rows: repeat(${l.filas}, 1fr)">
          ${hoja.items.map((c, i) => celda(c, l.pos[i])).join('')}
          ${posLibres.map((p) => `<div class="cell empty" style="grid-row: ${p[0]}; grid-column: ${p[1]} / span ${p[2]};">Vacío</div>`).join('')}
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
      for (const c of hoja.items) {
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
  function agregarArchivos(files) {
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
    // Repartir empezando por la última hoja con espacio; crear hojas nuevas si hace falta
    let hoja = state.hojas[state.hojas.length - 1] || crearHoja();
    if (!state.hojas.includes(hoja)) state.hojas.push(hoja);
    while (nuevas.length) {
      const cap = layoutDe(hoja.layout).total;
      while (hoja.items.length < cap && nuevas.length) {
        hoja.items.push(nuevas.shift());
      }
      if (nuevas.length) {
        hoja = crearHoja(hoja.layout);
        state.hojas.push(hoja);
      }
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
      const idx = h.items.findIndex((c) => c.id === id);
      if (idx >= 0) {
        URL.revokeObjectURL(h.items[idx].imgUrl);
        h.items.splice(idx, 1);
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

  // Arrastre entre hojas (mover comprobante de una hoja a otra)
  let dragSrc = null;
  sheetsEl.addEventListener('dragstart', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    dragSrc = cell;
    cell.classList.add('drag');
    e.dataTransfer.effectAllowed = 'move';
  });
  sheetsEl.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('drag');
    dragSrc = null;
  });
  sheetsEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const cell = e.target.closest('.cell');
    if (cell && cell !== dragSrc) cell.style.outline = '2px dashed var(--renglon-fuerte)';
  });
  sheetsEl.addEventListener('dragleave', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) cell.style.outline = '';
  });
  sheetsEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest?.('.cell');
    if (!cell || !dragSrc || cell === dragSrc) return;
    const hojaOrigen = dragSrc.closest('.sheet');
    const hojaDestino = cell.closest('.sheet');
    if (!hojaOrigen || !hojaDestino || hojaOrigen === hojaDestino) return;
    const id = Number(dragSrc.dataset.id);
    const origen = hojaPorId(hojaOrigen.dataset.hoja);
    const destino = hojaPorId(hojaDestino.dataset.hoja);
    if (!origen || !destino) return;
    const idx = origen.items.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const [item] = origen.items.splice(idx, 1);
    // Auto-desbordar: si la hoja destino no está llena, el item entra; si está
    // llena, entra y el último pasa a la siguiente con espacio (o crea una nueva).
    destino.items.push(item);
    if (destino.items.length > layoutDe(destino.layout).total) {
      reflowExceso(state.hojas.indexOf(destino));
    }
    limpiarHojas();
    guardar();
    renderHojas();
  });

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
      ...state.hojas.flatMap((h) => h.items).map((c) => `- ${c.nombre}: ${formatearMoneda(c.montoCents || 0)}`),
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
    const todos = state.hojas.flatMap((h) => h.items);
    selOcr.innerHTML = todos.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('');
    selOcr.dispatchEvent(new Event('change'));
    modalOcr.showModal();
  });
  selOcr.addEventListener('change', () => {
    const todos = state.hojas.flatMap((h) => h.items);
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
    for (const h of state.hojas) for (const c of h.items) URL.revokeObjectURL(c.imgUrl);
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
