/* Modal de ajustes: endpoint IA, modelo, key y moneda (persisten). */
import { guardar, state } from '../state';
import type { Moneda } from '../types';
import { renderMonto } from './monto';
import { renderHojas } from './sheets';
import { showToast } from './toast';
import { getEl } from '../utils';

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>('modalAjustes');
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>('btnAjustes');
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>('formAjustes');
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>('cfgBaseUrl');
const cfgModel: HTMLInputElement = getEl<HTMLInputElement>('cfgModel');
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>('cfgApiKey');
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>('cfgMoneda');

function isMoneda(v: string): v is Moneda {
  return v === 'USD' || v === 'ARS' || v === 'EUR';
}

export function initSettings(): void {
  btnAjustes.addEventListener('click', () => {
    cfgBaseUrl.value = state.configIA.baseUrl;
    cfgModel.value = state.configIA.model;
    cfgApiKey.value = state.configIA.apiKey;
    cfgMoneda.value = state.moneda;
    modalAjustes.showModal();
  });
  formAjustes.addEventListener('submit', () => {
    state.configIA.baseUrl = cfgBaseUrl.value || 'https://api.openai.com/v1';
    state.configIA.model = cfgModel.value || 'gpt-4o-mini';
    state.configIA.apiKey = cfgApiKey.value;
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : 'USD';
    guardar();
    renderMonto();
    renderHojas();
    showToast('Ajustes guardados.');
  });
}
