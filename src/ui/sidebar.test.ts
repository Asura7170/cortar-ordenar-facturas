/* Tests P1: sidebar — entrada de archivos, código de pedido y limpiar (DOM aislado). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { montarFixture, el, eventoDrop, eventoDragover, eventoPaste } from '../test/fixture';

montarFixture();
const { state, crearHoja } = await import('../state');
const { agregarArchivos, initSidebar, renderCodigo } = await import('./sidebar');
const { archivo, comprobante } = await import('../test/factoria');

const dropzone = el('dropzone');
const fileInput = el<HTMLInputElement>('fileInput');
const chkCodigo = el<HTMLInputElement>('chkCodigo');
const numCodigo = el<HTMLInputElement>('numCodigo');
const inputCodigo = el<HTMLInputElement>('inputCodigo');
const modalLimpiar = el<HTMLDialogElement>('modalLimpiar');

initSidebar();

beforeEach(() => {
  // La cola MOCK usa sleep(900ms): timers falsos para que nunca avance en tests.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('agregarArchivos', () => {
  it('null o vacío: no hace nada', () => {
    agregarArchivos(null);
    agregarArchivos([]);
    expect(state.hojas).toHaveLength(0);
  });

  it('filtra por tipo: imagen y pdf sí, txt no', () => {
    agregarArchivos([
      archivo('a.png', 'image/png'),
      archivo('b.txt', 'text/plain'),
      archivo('c.PDF', 'application/pdf'),
    ]);
    const nombres = state.hojas.flatMap((h) => h.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(['a.png', 'c.PDF', null, null]);
  });

  it('acepta pdf por extensión aunque el type sea genérico', () => {
    agregarArchivos([archivo('doc.pdf', 'application/octet-stream')]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it('crea el comprobante y la cola lo toma (procesando, sin avanzar)', () => {
    agregarArchivos([archivo('f.jpg', 'image/jpeg')]);
    const c = state.hojas[0]?.slots[0];
    // pendiente→procesando es sincrónico; el sleep(900) queda congelado.
    expect(c?.estado).toBe('procesando');
    expect(c?.montoCents).toBeNull();
    expect(c?.textoOcr).toBe('');
    expect(c?.imgUrl).toContain('blob:mock-');
  });

  it('rellena huecos de la última hoja y desborda heredando layout', () => {
    const h = crearHoja('u2h');
    h.slots[0] = comprobante();
    state.hojas.push(h);
    agregarArchivos([1, 2, 3].map((n) => archivo(`${n}.png`, 'image/png')));
    expect(state.hojas).toHaveLength(2);
    expect(state.hojas.every((x) => x.layout === 'u2h')).toBe(true);
    const nombres = state.hojas.flatMap((x) => x.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(['factura.png', '1.png', '2.png', '3.png']);
  });

  it('con hojaId rellena ESA hoja aunque otra tenga hueco', () => {
    const a = crearHoja();
    const b = crearHoja();
    state.hojas.push(a, b);
    agregarArchivos([archivo('x.png', 'image/png')], b.id);
    expect(a.slots.every((c) => c === null)).toBe(true);
    expect(b.slots[0]?.nombre).toBe('x.png');
  });

  it('dispara la cola (flag sincrónico) sin avanzar con timers falsos', () => {
    agregarArchivos([archivo('f.png', 'image/png')]);
    expect(state.colaEnProceso).toBe(true);
    expect(state.hojas[0]?.slots[0]?.estado).toBe('procesando');
  });
});

describe('fileInput / dropzone / paste', () => {
  it('change del input agrega y resetea el value', () => {
    Object.defineProperty(fileInput, 'files', {
      value: [archivo('in.png', 'image/png')],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
    expect(fileInput.value).toBe('');
  });

  it('dragover marca la zona y previene el default; dragleave limpia', () => {
    dropzone.dispatchEvent(eventoDragover());
    expect(dropzone.classList.contains('dragover')).toBe(true);
    dropzone.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(dropzone.classList.contains('dragover')).toBe(false);
  });

  it('drop agrega los archivos y limpia la marca', () => {
    dropzone.classList.add('dragover');
    dropzone.dispatchEvent(eventoDrop([archivo('d.png', 'image/png')]));
    expect(dropzone.classList.contains('dragover')).toBe(false);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it('paste con archivo agrega; sin archivos no hace nada', () => {
    document.dispatchEvent(eventoPaste([archivo('p.png', 'image/png')]));
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
    document.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });
});

describe('código de pedido', () => {
  it('switch activa/guarda y habilita el input', () => {
    renderCodigo();
    expect(inputCodigo.disabled).toBe(true);
    chkCodigo.checked = true;
    chkCodigo.dispatchEvent(new Event('change', { bubbles: true }));
    expect(state.codigoActivo).toBe(true);
    expect(inputCodigo.disabled).toBe(false);
    expect(JSON.parse(localStorage.getItem('libro-mayor-state') ?? '{}')).toMatchObject({ codigoActivo: true });
  });

  it('longitud clamp 1..12 y fallback 6', () => {
    numCodigo.value = '99';
    numCodigo.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.codigoLongitud).toBe(12);
    expect(numCodigo.value).toBe('12');
    numCodigo.value = 'abc';
    numCodigo.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.codigoLongitud).toBe(6);
  });

  it('valor deja solo dígitos y corta a la longitud', () => {
    state.codigoLongitud = 6;
    inputCodigo.value = '12ab3456789';
    inputCodigo.dispatchEvent(new Event('input', { bubbles: true }));
    expect(state.codigoValor).toBe('123456');
    expect(inputCodigo.value).toBe('123456');
  });
});

describe('modalLimpiar', () => {
  it('confirmar vacía a una hoja fresca y revoca URLs', () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ imgUrl: 'blob:img', thumbUrl: 'blob:thumb' });
    h.slots[1] = comprobante({ imgUrl: 'blob:img2', thumbUrl: null });
    state.hojas.push(h);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    modalLimpiar.returnValue = 'ok';
    modalLimpiar.close();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]?.slots.every((c) => c === null)).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:img');
    expect(revoke).toHaveBeenCalledWith('blob:thumb');
    expect(revoke).toHaveBeenCalledWith('blob:img2');
  });

  it('cancelar no toca nada', () => {
    const h = crearHoja();
    h.slots[0] = comprobante();
    state.hojas.push(h);
    modalLimpiar.returnValue = '';
    modalLimpiar.close();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]).toBe(h);
  });
});
