/* Tests P1: modal de ajustes — submit y Predeterminado (DOM aislado). */
import { describe, expect, it } from 'vitest';
import { montarFixture, el } from '../test/fixture';

montarFixture();
const { state, crearHoja, guardarCodigo } = await import('../state');
const { initSettings } = await import('./settingsModal');
const { comprobante } = await import('../test/factoria');

const modalAjustes = el<HTMLDialogElement>('modalAjustes');
const btnAjustes = el<HTMLButtonElement>('btnAjustes');
const formAjustes = el<HTMLFormElement>('formAjustes');
const cfgBaseUrl = el<HTMLInputElement>('cfgBaseUrl');
const cfgModel = el<HTMLInputElement>('cfgModel');
const cfgApiKey = el<HTMLInputElement>('cfgApiKey');
const cfgMoneda = el<HTMLSelectElement>('cfgMoneda');
const btnResetAjustes = el<HTMLButtonElement>('btnResetAjustes');

initSettings();

function enviar(): void {
  formAjustes.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('abrir', () => {
  it('pinta los valores actuales y abre el modal', () => {
    state.configIA = { baseUrl: 'http://a', model: 'm', apiKey: 'k' };
    state.moneda = 'BOB';
    btnAjustes.click();
    expect(cfgBaseUrl.value).toBe('http://a');
    expect(cfgModel.value).toBe('m');
    expect(cfgApiKey.value).toBe('k');
    expect(cfgMoneda.value).toBe('BOB');
    expect(modalAjustes.hasAttribute('open')).toBe(true);
    modalAjustes.close();
  });
});

describe('submit', () => {
  it('persiste config+moneda, deja el código intacto y repinta el total', () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ montoCents: 100 });
    state.hojas.push(h);
    state.codigoValor = '777';
    guardarCodigo();
    cfgBaseUrl.value = 'http://nuevo';
    cfgModel.value = 'modelo-x';
    cfgApiKey.value = 'secreto';
    cfgMoneda.value = 'ARS';
    enviar();
    expect(state.configIA).toEqual({ baseUrl: 'http://nuevo', model: 'modelo-x', apiKey: 'secreto' });
    expect(state.moneda).toBe('ARS');
    expect(document.getElementById('montoTotal')?.textContent).toBe('AR$ 1.00');
    const raw = JSON.parse(localStorage.getItem('libro-mayor-state') ?? '{}') as Record<string, unknown>;
    expect(raw['moneda']).toBe('ARS');
    expect(raw['codigoValor']).toBe('777');
  });

  it('vacíos caen a defaults Groq y moneda inválida a USD', () => {
    cfgBaseUrl.value = '';
    cfgModel.value = '';
    cfgApiKey.value = '';
    cfgMoneda.value = 'XXX';
    enviar();
    expect(state.configIA.baseUrl).toContain('groq');
    expect(state.configIA.model).toBe('qwen/qwen3.8-27b');
    expect(state.moneda).toBe('USD');
  });
});

describe('Predeterminado', () => {
  it('resetea, repinta inputs y total', () => {
    state.configIA = { baseUrl: 'xxx', model: 'yyy', apiKey: 'zzz' };
    state.moneda = 'EUR';
    btnResetAjustes.click();
    expect(state.configIA.baseUrl).toContain('groq');
    expect(state.moneda).toBe('USD');
    expect(cfgBaseUrl.value).toContain('groq');
    expect(cfgModel.value).toBe('qwen/qwen3.8-27b');
    expect(cfgApiKey.value).toBe('');
    expect(cfgMoneda.value).toBe('USD');
  });
});
