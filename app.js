/* ============================================================
   CORTAR Y ORDENAR FACTURAS — app.js (esqueleto funcional)
   Diseño 1 · Libro Mayor
   ------------------------------------------------------------------
   Este esqueléto maneja el estado mínimo del flujo:
   - entrada (dropzone / pegar / subir)
   - cola secuencial de procesamiento (placeholder para OpenCV+OCR)
   - monto acumulado en cents (suma exacta)
   - N comprobantes por hoja, reordenar con arrastre
   - código de pedido persistente, modal OCR y ajustes
   - export .docx (stub que arma un Blob)
   ============================================================ */

(function () {
  'use strict';

  /* ---------- Estado global ---------- */
  const state = {
    comprobantes: [],      // {id, nombre, imgUrl, textoOcr, montoCents|null, moneda, estado, posicion}
    nup: 4,
    codigoActivo: false,
    codigoLongitud: 6,
    codigoValor: '',
    configIA: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
    moneda: 'USD',
    colaEnProceso: false,
  };

  const LS_KEY = 'libro-mayor-state';
  const MONEDAS = { USD: { simbolo: 'US$', factor: 1 }, ARS: { simbolo: 'AR$', factor: 1 }, EUR: { simbolo: '€', factor: 1 } };

  let seq = 0;

  /* ---------- Referencias DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const sheetsEl = $('sheets');
  const montoEl = $('montoTotal');
  const metaHojas = $('metaHojas');
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const btnPegar = $('btnPegar');
  const chkCodigo = $('chkCodigo');
  const numCodigo = $('numCodigo');
  const inputCodigo = $('inputCodigo');
  const selNup = $('selNup');
  const btnOcr = $('btnOcr');
  const btnLimpiar = $('btnLimpiar');
  const btnDescargar = $('btnDescargar');
  const btnDescargar2 = $('btnDescargar2');
  const btnAjustes = $('btnAjustes');

  /* ---------- Persistencia ---------- */
  function guardar() {
    const persist = {
      nup: state.nup,
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
      state.nup = p.nup ?? 4;
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
    return state.comprobantes.reduce((acc, c) => acc + (c.montoCents || 0), 0);
  }

  function renderMonto() {
    montoEl.textContent = formatearMoneda(sumaTotal());
  }

  /* ---------- Hojas ---------- */
  function paginar() {
    const n = state.nup;
    const hojas = [];
    for (let i = 0; i < state.comprobantes.length; i += n) {
      hojas.push(state.comprobantes.slice(i, i + n));
    }
    return hojas;
  }

  function posicionesGrid(n) {
    // patrones de grilla razonables por N
    switch (n) {
      case 1: return [['1fr', '1fr']];
      case 2: return [['1fr', '1fr']];
      case 3: return [['1fr', '1fr', '1fr']];
      case 5: return [['1fr', '1fr'], ['1fr', '1fr', '1fr']];
      default: return [['1fr', '1fr'], ['1fr', '1fr']]; // 4 y 6 (6 => 2 filas 3 cols)
    }
  }

  function renderHojas() {
    const hojas = paginar();
    metaHojas.textContent = `${hojas.length} hoja${hojas.length === 1 ? '' : 's'} · ${state.comprobantes.length} comprobante${state.comprobantes.length === 1 ? '' : 's'}`;
    sheetsEl.innerHTML = '';

    if (state.comprobantes.length === 0) {
      sheetsEl.innerHTML = `
        <div class="empty-state">
          <h2>Comenzá pegando tus comprobantes</h2>
          <p>Usá <strong>Ctrl+V</strong>, arrastrá imágenes o hacé clic en el cuadro de entrada. Cada comprobante se recorta, se lee su texto y se suma su total.</p>
        </div>`;
      return;
    }

    hojas.forEach((items, idx) => {
      const sheet = document.createElement('article');
      sheet.className = 'sheet';
      sheet.dataset.hoja = idx + 1;
      const cols = state.nup >= 3 ? 3 : state.nup;
      const grid = posicionesGrid(state.nup);
      sheet.innerHTML = `
        <span class="sheet-tag">HOJA ${idx + 1}</span>
        <div class="sheet-grid" style="grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: ${grid.length === 2 ? '1fr 1fr' : '1fr'}">
          ${items.map((c) => celda(c)).join('')}
          ${Array.from({ length: Math.max(0, state.nup - items.length) }, () => '<div class="cell empty">Vacío</div>').join('')}
        </div>`;
      sheetsEl.appendChild(sheet);
    });
    renderMonto();
  }

  function celda(c) {
    const badge = c.montoCents != null ? `<span class="cell-badge">${formatearMoneda(c.montoCents)}</span>` : '';
    return `
      <div class="cell cell-${c.estado}" data-id="${c.id}">
        <img src="${c.imgUrl}" alt="${c.nombre}" draggable="true" />
        <button class="cell-remove" data-accion="quitar" title="Quitar">×</button>
        ${badge}
      </div>`;
  }

  /* ---------- Cola de procesamiento (placeholder) ---------- */
  async function procesarCola() {
    if (state.colaEnProceso) return;
    state.colaEnProceso = true;
    for (const c of state.comprobantes) {
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
    state.colaEnProceso = false;
  }

  /* ---------- Entrada ---------- */
  function agregarArchivos(files) {
    const validos = Array.from(files).filter((f) => /^image\/(jpeg|png|webp|bmp|gif)$/.test(f.type) || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0 && validos.length === 0) {
      showToast('Solo se aceptan imágenes (JPG, PNG, WEBP, BMP, GIF) o PDF. HEIC no soportado.');
    }
    for (const f of validos) {
      const id = ++seq;
      const url = URL.createObjectURL(f);
      const moneda = 'USD';
      state.comprobantes.push({
        id, nombre: f.name, imgUrl: url, textoOcr: '',
        montoCents: null, moneda, estado: 'pendiente', posicion: state.comprobantes.length,
      });
    }
    renderHojas();
    procesarCola();
  }

  dropzone.addEventListener('click', () => fileInput.click());
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

  btnPegar.addEventListener('click', () => fileInput.click());

  /* ---------- Quitar / drag ---------- */
  sheetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-accion="quitar"]');
    if (!btn) return;
    const cell = btn.closest('.cell');
    const id = Number(cell.dataset.id);
    const idx = state.comprobantes.findIndex((c) => c.id === id);
    if (idx >= 0) {
      URL.revokeObjectURL(state.comprobantes[idx].imgUrl);
      state.comprobantes.splice(idx, 1);
    }
    renderHojas();
  });

  // Arrastre libre dentro de la hoja (posición física; el orden no cambia)
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
    // En el esqueleto: mover la imagen visualmente dentro de la hoja (swap de contenido de celda)
    const imgSrc = dragSrc.querySelector('img');
    const imgDest = cell.querySelector('img');
    if (imgSrc && imgDest) {
      const tmp = imgSrc.src;
      imgSrc.src = imgDest.src;
      imgDest.src = tmp;
    }
    cell.style.outline = '';
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
    if (state.comprobantes.length === 0) { showToast('No hay comprobantes para descargar.'); return; }
    showToast('Generando .docx… (esqueleto)');

    // Stub: armar un blob de texto simple (en la implementación real usa docx.js)
    const contenido = [
      'DOCX STUB — Cortar y Ordenar Facturas',
      `Código de pedido: ${state.codigoActivo ? state.codigoValor : '(sin código)'}`,
      `Hojas: ${paginar().length}`,
      ...state.comprobantes.map((c) => `- ${c.nombre}: ${formatearMoneda(c.montoCents || 0)}`),
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
  btnDescargar.addEventListener('click', descargarWord);
  btnDescargar2.addEventListener('click', descargarWord);

  /* ---------- Modal OCR ---------- */
  const modalOcr = $('modalOcr');
  const selOcr = $('selOcr');
  const ocrTexto = $('ocrTexto');
  btnOcr.addEventListener('click', () => {
    if (state.comprobantes.length === 0) { showToast('No hay comprobantes todavía.'); return; }
    selOcr.innerHTML = state.comprobantes.map((c) => `<option value="${c.id}">${c.nombre}</option>`).join('');
    selOcr.dispatchEvent(new Event('change'));
    modalOcr.hidden = false;
  });
  selOcr.addEventListener('change', () => {
    const c = state.comprobantes.find((x) => x.id === Number(selOcr.value));
    ocrTexto.textContent = c?.textoOcr || '(sin texto OCR)';
  });
  $('btnCerrarModal').addEventListener('click', () => { modalOcr.hidden = true; });
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
    modalAjustes.hidden = false;
  });
  $('btnCerrarAjustes').addEventListener('click', () => { modalAjustes.hidden = true; });
  $('btnGuardarAjustes').addEventListener('click', () => {
    state.configIA.baseUrl = $('cfgBaseUrl').value || 'https://api.openai.com/v1';
    state.configIA.model = $('cfgModel').value || 'gpt-4o-mini';
    state.configIA.apiKey = $('cfgApiKey').value;
    state.moneda = $('cfgMoneda').value;
    guardar();
    renderMonto();
    renderHojas();
    modalAjustes.hidden = true;
    showToast('Ajustes guardados.');
  });

  /* ---------- Limpiar ---------- */
  btnLimpiar.addEventListener('click', () => {
    for (const c of state.comprobantes) URL.revokeObjectURL(c.imgUrl);
    state.comprobantes = [];
    renderHojas();
    showToast('Lote limpiado. Se conservan check, N y ajustes.');
  });

  /* ---------- N-up ---------- */
  selNup.addEventListener('change', () => {
    state.nup = Number(selNup.value);
    guardar();
    renderHojas();
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

  /* ---------- Init ---------- */
  cargar();
  selNup.value = state.nup;
  renderCodigo();
  renderHojas();
})();
