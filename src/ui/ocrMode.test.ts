/* Tests P1: switch del modo OCR (DOM aislado). */
import { describe, expect, it } from 'vitest';
import { montarFixture, el } from '../test/fixture';

montarFixture();
const { state } = await import('../state');
const { initOcrMode, renderOcrToggle } = await import('./ocrMode');

const chkOcr = el<HTMLInputElement>('chkOcr');
const ocrEstado = el('ocrEstado');

initOcrMode();

function cambiar(checked: boolean): void {
  chkOcr.checked = checked;
  chkOcr.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('initOcrMode', () => {
  it('enciende: estado, etiqueta ON y clase', () => {
    cambiar(true);
    expect(state.modoOcr).toBe(true);
    expect(ocrEstado.textContent).toBe('ON');
    expect(ocrEstado.classList.contains('on')).toBe(true);
  });

  it('apaga: etiqueta OFF sin clase', () => {
    state.modoOcr = true;
    renderOcrToggle();
    cambiar(false);
    expect(state.modoOcr).toBe(false);
    expect(ocrEstado.textContent).toBe('OFF');
    expect(ocrEstado.classList.contains('on')).toBe(false);
  });

  it('change sin cambio real es no-op', () => {
    state.modoOcr = false;
    renderOcrToggle();
    cambiar(false);
    expect(state.modoOcr).toBe(false);
    expect(ocrEstado.textContent).toBe('OFF');
  });
});

describe('renderOcrToggle', () => {
  it('refleja el estado en ambos sentidos', () => {
    state.modoOcr = true;
    renderOcrToggle();
    expect(chkOcr.checked).toBe(true);
    expect(ocrEstado.textContent).toBe('ON');
    state.modoOcr = false;
    renderOcrToggle();
    expect(chkOcr.checked).toBe(false);
    expect(ocrEstado.textContent).toBe('OFF');
  });
});
