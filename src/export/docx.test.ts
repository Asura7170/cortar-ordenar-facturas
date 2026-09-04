/* Tests P0/P1: export STUB (docx.ts necesita #montoTotal y #btnDescargar2 al importar). */
import { afterEach, describe, expect, it, vi } from 'vitest';

document.body.innerHTML = '<div id="montoTotal"></div><button id="btnDescargar2"></button>';
const { state, crearHoja } = await import('../state');
const { codigoValido, descargarWord, initExport, nombreArchivo } = await import('./docx');
const { comprobante } = await import('../test/factoria');

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function sembrar(monto: number | null = 123456): void {
  const h = crearHoja();
  h.slots[0] = comprobante({ montoCents: monto });
  state.hojas.push(h);
}

describe('codigoValido', () => {
  it('sin código activo siempre vale', () => {
    state.codigoActivo = false;
    state.codigoValor = 'cualquier-cosa';
    expect(codigoValido()).toBe(true);
  });

  it.each([
    ['123456', 6, true],
    ['12345', 6, false],
    ['1234567', 6, false],
    ['12345a', 6, false],
    ['', 6, false],
  ])('valor %s con longitud %i → %s', (valor, longitud, esperado) => {
    state.codigoActivo = true;
    state.codigoLongitud = longitud;
    state.codigoValor = valor;
    expect(codigoValido()).toBe(esperado);
  });
});

describe('nombreArchivo', () => {
  it('con código usa el valor, sin código usa "sincodigo"', () => {
    state.codigoActivo = true;
    state.codigoValor = '123456';
    expect(nombreArchivo()).toBe('123456-comprobante.docx');
    state.codigoActivo = false;
    expect(nombreArchivo()).toBe('sincodigo-comprobante.docx');
  });
});

describe('descargarWord (STUB)', () => {
  it('código inválido: no dispara descarga', async () => {
    state.codigoActivo = true;
    state.codigoValor = 'corto';
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
  });

  it('sin comprobantes: no dispara descarga', async () => {
    state.codigoActivo = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
  });

  it('válido: clic con nombre y blob, y revoca a los 2s', async () => {
    vi.useFakeTimers();
    state.codigoActivo = false;
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await descargarWord();
    expect(click).toHaveBeenCalledTimes(1);
    const a = click.mock.instances[0] as HTMLAnchorElement;
    expect(a.download).toBe('sincodigo-comprobante.docx');
    expect(a.href).toContain('blob:mock-');
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('initExport', () => {
  it('cablea el botón a descargarWord', async () => {
    state.codigoActivo = false;
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    initExport();
    document.getElementById('btnDescargar2')?.click();
    expect(click).toHaveBeenCalledTimes(1);
  });
});
