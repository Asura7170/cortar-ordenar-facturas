/* Tests P1: hojas — layouts, quitar, clic delegado, drop y celdas (DOM aislado). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { montarFixture, eventoDrop, eventoDragover } from '../test/fixture';

montarFixture();
const { state, crearHoja } = await import('../state');
const {
  actualizarMiniatura,
  aplicarATodas,
  cambiarLayoutHoja,
  esDragDeArchivos,
  initSheets,
  quitarComprobante,
  renderHojas,
} = await import('./sheets');
const { archivo, comprobante } = await import('../test/factoria');
import type { Hoja, LayoutId } from '../types';

const agregarArchivos = vi.fn();
initSheets({ agregarArchivos });

afterEach(() => {
  vi.restoreAllMocks();
  agregarArchivos.mockClear();
});

/** Siembra una hoja con montos (null = casilla vacía) y la pinta. */
function sembrar(layout: LayoutId, montos: (number | null)[]): Hoja {
  const h = crearHoja(layout);
  h.slots = montos.map((m) => (m === null ? null : comprobante({ montoCents: m })));
  state.hojas.push(h);
  renderHojas();
  return h;
}

function boton(accion: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(`[data-accion="${accion}"]`);
  if (!b) throw new Error(`sin botón ${accion}`);
  return b;
}

describe('cambiarLayoutHoja / aplicarATodas', () => {
  it('ids inválidos no hacen nada', () => {
    const h = sembrar('u4x2', [10, 20]);
    cambiarLayoutHoja(-1, 'u1');
    cambiarLayoutHoja(h.id, 'bogus');
    expect(h.layout).toBe('u4x2');
    expect(state.hojas).toHaveLength(1);
  });

  it('achica y refluye: 4 items u4x2 → u1 deja 4 hojas', () => {
    const h = sembrar('u4x2', [1, 2, 3, 4]);
    cambiarLayoutHoja(h.id, 'u1');
    expect(state.hojas).toHaveLength(4);
    expect(state.hojas.every((x) => x.slots.filter(Boolean).length <= 1)).toBe(true);
  });

  it('aplicarATodas propaga el layout origen', () => {
    const a = sembrar('u1', [10]);
    const b = crearHoja('u6x2');
    b.slots[0] = comprobante({ montoCents: 20 });
    state.hojas.push(b);
    renderHojas();
    aplicarATodas(a.id);
    expect(state.hojas.every((x) => x.layout === 'u1')).toBe(true);
    expect(state.hojas.flatMap((x) => x.slots).filter(Boolean)).toHaveLength(2);
  });
});

describe('quitarComprobante', () => {
  it('quita, revoca img+thumb y elimina la hoja vaciada', () => {
    const a = sembrar('u4x2', [null]);
    const b = crearHoja();
    const c = comprobante({ imgUrl: 'blob:img', thumbUrl: 'blob:thumb' });
    b.slots[0] = c;
    state.hojas.push(b);
    renderHojas();
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    quitarComprobante(c.id);
    expect(a.slots.every((s) => s === null)).toBe(true);
    expect(state.hojas).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith('blob:img');
    expect(revoke).toHaveBeenCalledWith('blob:thumb');
  });

  it('id inexistente no tira', () => {
    sembrar('u4x2', [10]);
    expect(() => quitarComprobante(-1)).not.toThrow();
    expect(state.hojas).toHaveLength(1);
  });
});

describe('clic delegado', () => {
  it('× quita el comprobante', () => {
    sembrar('u4x2', [100]);
    boton('quitar').click();
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(document.querySelector('.empty-state')).not.toBeNull();
  });

  it('tarjeta de layout cambia la plantilla', () => {
    const h = sembrar('u4x2', [100]);
    document.querySelector<HTMLButtonElement>('.grid-opt[data-layout="u1"]')?.click();
    expect(h.layout).toBe('u1');
  });

  it('aplicar a todas desde el panel', () => {
    sembrar('u1', [10]);
    const b = crearHoja('u6x2');
    b.slots[0] = comprobante();
    state.hojas.push(b);
    renderHojas();
    boton('apply-all').click();
    expect(new Set(state.hojas.map((x) => x.layout)).size).toBe(1);
  });

  it('⧉ copia el OCR solo si hay texto (y solo existe en modo OCR)', () => {
    state.modoOcr = true;
    const h = crearHoja();
    h.slots[0] = comprobante({ textoOcr: 'HOLA' });
    h.slots[1] = comprobante({ textoOcr: '' });
    state.hojas.push(h);
    renderHojas();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const botones = [...document.querySelectorAll<HTMLButtonElement>('[data-accion="copiar-ocr"]')];
    expect(botones).toHaveLength(2);
    botones[0]?.click();
    expect(write).toHaveBeenCalledWith('HOLA');
    write.mockClear();
    botones[1]?.click();
    expect(write).not.toHaveBeenCalled();
  });

  it('⧉ sin clipboard API (http): marca fallo sin tirar', () => {
    state.modoOcr = true;
    const h = crearHoja();
    h.slots[0] = comprobante({ textoOcr: 'HOLA' });
    state.hojas.push(h);
    renderHojas();
    const real = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      const btn = boton('copiar-ocr');
      expect(() => btn.click()).not.toThrow();
      expect(btn.title).toContain('Copiar falló');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: real, configurable: true });
    }
  });

  it('sin modo OCR no hay botón ⧉', () => {
    sembrar('u4x2', [100]);
    expect(document.querySelector('[data-accion="copiar-ocr"]')).toBeNull();
  });
});

describe('celdas', () => {
  it('ocupada tabindex 0, vacía -1', () => {
    sembrar('u4x2', [100, null, null, null]);
    const tabs = [...document.querySelectorAll('.cell')].map((c) => (c as HTMLElement).tabIndex);
    expect(tabs).toEqual([0, -1, -1, -1]);
  });

  it('badge con el monto formateado', () => {
    state.moneda = 'USD';
    sembrar('u4x2', [123456]);
    expect(document.querySelector('.cell-badge')?.textContent).toBe('US$ 1,234.56');
  });

  it('actualizarMiniatura pinta el thumb sin reconstruir', () => {
    const h = sembrar('u4x2', [null]);
    // Con file de imagen y sin thumb: esqueleto, sin <img>.
    const c = comprobante({ imgUrl: 'blob:full', file: archivo('f.png', 'image/png') });
    h.slots[0] = c;
    renderHojas();
    expect(document.querySelector('.cell img')).toBeNull();
    c.thumbUrl = 'blob:thumb';
    actualizarMiniatura(c.id);
    expect(document.querySelector<HTMLImageElement>('.cell img')?.src).toContain('blob:thumb');
  });

  it('actualizarMiniatura con id inexistente no tira', () => {
    sembrar('u4x2', [100]);
    expect(() => actualizarMiniatura(-1)).not.toThrow();
  });
});

describe('drop de archivos sobre hojas', () => {
  it('esDragDeArchivos detecta Files', () => {
    const con = { dataTransfer: { types: ['Files'] } } as unknown as DragEvent;
    const sin = { dataTransfer: { types: ['text/plain'] } } as unknown as DragEvent;
    const vacio = {} as DragEvent;
    expect(esDragDeArchivos(con)).toBe(true);
    expect(esDragDeArchivos(sin)).toBe(false);
    expect(esDragDeArchivos(vacio)).toBe(false);
  });

  it('drop delega al callback con el id de la hoja', () => {
    const h = sembrar('u4x2', [100]);
    const files = [new File(['x'], 'd.png', { type: 'image/png' })];
    document.querySelector('.sheet')?.dispatchEvent(eventoDrop(files));
    expect(agregarArchivos).toHaveBeenCalledWith(files, h.id);
  });

  it('en modo OCR el drop se bloquea', () => {
    state.modoOcr = true;
    sembrar('u4x2', [100]);
    document.querySelector('.sheet')?.dispatchEvent(
      eventoDrop([new File(['x'], 'd.png', { type: 'image/png' })]),
    );
    expect(agregarArchivos).not.toHaveBeenCalled();
  });

  it('dragover con Files resalta la hoja; sin Files no', () => {
    sembrar('u4x2', [100]);
    const sheet = document.querySelector('.sheet');
    if (!sheet) throw new Error('sin .sheet');
    sheet.dispatchEvent(eventoDragover());
    expect(sheet.classList.contains('file-drop')).toBe(true);
    sheet.classList.remove('file-drop');
    const e = eventoDragover(['text/plain']);
    sheet.dispatchEvent(e);
    expect(sheet.classList.contains('file-drop')).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});
