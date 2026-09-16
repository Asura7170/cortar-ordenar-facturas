/* Modal de ajustes: endpoint IA, modelo, key y moneda (persisten). */
import {
  CONFIG_IA_DEFAULT,
  MONEDA_DEFAULT,
  guardarAjustes,
  isMoneda,
  restablecerAjustes,
  state,
} from "../state";
import { renderMonto } from "./monto";
import { renderHojas } from "./sheets";
import { getEl } from "../utils";
import { borrarModelos, descargarPesos, tamanoModelos } from "../pipeline/docaligner";
import { descargarPesosOcr } from "../pipeline/ocr";

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>("modalAjustes");
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnAjustes");
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>("formAjustes");
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>("cfgBaseUrl");
const cfgModel: HTMLInputElement = getEl<HTMLInputElement>("cfgModel");
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>("cfgApiKey");
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnResetAjustes");
const estadoModelos: HTMLElement = getEl("estadoModelos");
const btnDescargarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargarModelos");
const btnBorrarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarModelos");

function textoModelos(bytes: number): string {
  return bytes > 0
    ? `Modelos: ~${Math.round(bytes / 1048576)} MB en este navegador`
    : "Modelos: no descargados";
}

async function pintarModelos(): Promise<void> {
  estadoModelos.textContent = textoModelos(await tamanoModelos());
}

function pintarAjustes(): void {
  cfgBaseUrl.value = state.configIA.baseUrl;
  cfgModel.value = state.configIA.model;
  cfgApiKey.value = state.configIA.apiKey;
  cfgMoneda.value = state.moneda;
  void pintarModelos();
}

export function initSettings(): void {
  btnAjustes.addEventListener("click", () => {
    pintarAjustes();
    modalAjustes.showModal();
  });
  btnResetAjustes.addEventListener("click", () => {
    restablecerAjustes();
    pintarAjustes();
    renderMonto();
    renderHojas();
  });
  btnDescargarModelos.addEventListener("click", () => {
    btnDescargarModelos.disabled = true;
    btnBorrarModelos.disabled = true;
    estadoModelos.textContent = "Modelos: descargando…";
    void Promise.all([descargarPesos(), descargarPesosOcr()])
      .then(
        () => pintarModelos(),
        () => {
          estadoModelos.textContent = "Modelos: no se pudo descargar (revisa tu conexión)";
        },
      )
      .finally(() => {
        btnDescargarModelos.disabled = false;
        btnBorrarModelos.disabled = false;
      });
  });
  btnBorrarModelos.addEventListener("click", () => {
    void borrarModelos().then((habia) => {
      estadoModelos.textContent = habia
        ? "Modelos: borrados (se descargan de nuevo al usarse)"
        : "Modelos: no había nada descargado";
    });
  });
  formAjustes.addEventListener("submit", () => {
    state.configIA.baseUrl = cfgBaseUrl.value || CONFIG_IA_DEFAULT.baseUrl;
    state.configIA.model = cfgModel.value || CONFIG_IA_DEFAULT.model;
    state.configIA.apiKey = cfgApiKey.value;
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardarAjustes();
    renderMonto();
    renderHojas();
  });
}
