/* Modal de ajustes: endpoint IA, modelo, key y moneda (persisten). */
import { CONFIG_IA_DEFAULT, MONEDA_DEFAULT, guardar, isMoneda, restablecerAjustes, state } from '../state';
import { renderMonto } from './monto';
import { renderHojas } from './sheets';
import { getEl } from '../utils';

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>('modalAjustes');
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>('btnAjustes');
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>('formAjustes');
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>('cfgBaseUrl');
const cfgModel: HTMLInputElement = getEl<HTMLInputElement>('cfgModel');
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>('cfgApiKey');
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>('cfgMoneda');
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>('btnResetAjustes');

function pintarAjustes(): void {
  cfgBaseUrl.value = state.configIA.baseUrl;
  cfgModel.value = state.configIA.model;
  cfgApiKey.value = state.configIA.apiKey;
  cfgMoneda.value = state.moneda;
}

export function initSettings(): void {
  btnAjustes.addEventListener('click', () => {
    pintarAjustes();
    modalAjustes.showModal();
  });
  btnResetAjustes.addEventListener('click', () => {
    restablecerAjustes();
    pintarAjustes();
    renderMonto();
    renderHojas();
  });
  formAjustes.addEventListener('submit', () => {
    state.configIA.baseUrl = cfgBaseUrl.value || CONFIG_IA_DEFAULT.baseUrl;
    state.configIA.model = cfgModel.value || CONFIG_IA_DEFAULT.model;
    state.configIA.apiKey = cfgApiKey.value;
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardar();
    renderMonto();
    renderHojas();
  });
}
