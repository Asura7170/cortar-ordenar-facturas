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
import { detectarTipo, listarModelos } from "../pipeline/modelos";

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>("modalAjustes");
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnAjustes");
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>("formAjustes");
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>("cfgBaseUrl");
const cfgModel: HTMLSelectElement = getEl<HTMLSelectElement>("cfgModel");
const cfgModelManual: HTMLInputElement = getEl<HTMLInputElement>("cfgModelManual");
const btnRefrescarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnRefrescarModelos");
const estadoModelosIA: HTMLElement = getEl("estadoModelosIA");
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>("cfgApiKey");
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnResetAjustes");
const estadoModelos: HTMLElement = getEl("estadoModelos");
const btnDescargarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargarModelos");
const btnBorrarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarModelos");

const MANUAL = "__manual__";

function textoModelos(bytes: number): string {
  return bytes > 0
    ? `Modelos: ~${Math.round(bytes / 1048576)} MB en este navegador`
    : "Modelos: no descargados";
}

async function pintarModelos(): Promise<void> {
  try {
    estadoModelos.textContent = textoModelos(await tamanoModelos());
  } catch {
    estadoModelos.textContent = "Modelos: no se pudo consultar el almacenamiento";
  }
}

/** Opciones = lista + actual si falta (no perder dato) + escape manual. */
function pintarOpciones(lista: readonly string[], actual: string): void {
  cfgModel.innerHTML = "";
  const vistos = new Set<string>();
  const agregar = (v: string): void => {
    if (vistos.has(v)) return;
    vistos.add(v);
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    cfgModel.append(o);
  };
  if (actual.trim() !== "") agregar(actual);
  for (const m of lista) agregar(m);
  const o = document.createElement("option");
  o.value = MANUAL;
  o.textContent = "Otro (escribir…)";
  cfgModel.append(o);
  const enLista = actual.trim() !== "" && vistos.has(actual);
  cfgModel.value = enLista ? actual : actual.trim() !== "" && lista.length === 0 ? actual : MANUAL;
  if (!enLista && lista.length > 0 && actual.trim() === "") cfgModel.value = lista[0] ?? MANUAL;
  cfgModelManual.hidden = cfgModel.value !== MANUAL;
  if (cfgModel.value === MANUAL && actual.trim() !== "" && !vistos.has(actual))
    cfgModelManual.value = actual;
}

function modeloElegido(): string {
  return cfgModel.value === MANUAL ? cfgModelManual.value : cfgModel.value;
}

async function cargarModelos(forzado: boolean): Promise<void> {
  const base = cfgBaseUrl.value || CONFIG_IA_DEFAULT.baseUrl;
  const key = cfgApiKey.value;
  const tipo = detectarTipo(base);
  if (key.trim() === "") {
    estadoModelosIA.textContent = `Modelos (${tipo}): falta API key.`;
    btnRefrescarModelos.disabled = true;
    return;
  }
  btnRefrescarModelos.disabled = false;
  if (!forzado && cfgModel.options.length > 1) return; // ponytail: memoria del select, sin caché extra
  const actual = modeloElegido() || state.configIA.model;
  btnRefrescarModelos.disabled = true;
  estadoModelosIA.textContent = `Modelos (${tipo}): cargando…`;
  try {
    const lista = await listarModelos(base, key);
    pintarOpciones(lista, actual);
    estadoModelosIA.textContent =
      lista.length > 0
        ? `Modelos (${tipo}): ${lista.length} disponibles.`
        : `Modelos (${tipo}): sin lista (revisá URL, clave, CORS).`;
  } catch (e: unknown) {
    pintarOpciones([], actual);
    estadoModelosIA.textContent =
      `Modelos (${tipo}): no se pudo listar (` + (e instanceof Error ? e.message : "error") + ").";
  } finally {
    btnRefrescarModelos.disabled = key.trim() === "";
  }
}

function pintarAjustes(): void {
  cfgBaseUrl.value = state.configIA.baseUrl;
  cfgApiKey.value = state.configIA.apiKey;
  cfgMoneda.value = state.moneda;
  cfgModelManual.value = "";
  pintarOpciones([], state.configIA.model);
  void pintarModelos();
  void cargarModelos(false);
}

export function initSettings(): void {
  btnAjustes.addEventListener("click", () => {
    pintarAjustes();
    modalAjustes.showModal();
  });
  cfgModel.addEventListener("change", () => {
    cfgModelManual.hidden = cfgModel.value !== MANUAL;
    if (cfgModel.value === MANUAL) cfgModelManual.focus();
  });
  cfgApiKey.addEventListener("input", () => {
    btnRefrescarModelos.disabled = cfgApiKey.value.trim() === "";
  });
  btnRefrescarModelos.addEventListener("click", () => {
    void cargarModelos(true);
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
        (e: unknown) => {
          console.warn("modelos:", e);
          estadoModelos.textContent =
            "Modelos: no se pudo descargar (" + (e instanceof Error ? e.message : "error") + ")";
        },
      )
      .finally(() => {
        btnDescargarModelos.disabled = false;
        btnBorrarModelos.disabled = false;
      });
  });
  btnBorrarModelos.addEventListener("click", () => {
    void borrarModelos().then(
      (habia) => {
        estadoModelos.textContent = habia
          ? "Modelos: borrados (se descargan de nuevo al usarse)"
          : "Modelos: no había nada descargado";
      },
      (e: unknown) => {
        console.warn("modelos:", e);
        estadoModelos.textContent =
          "Modelos: no se pudo borrar (" + (e instanceof Error ? e.message : "error") + ")";
      },
    );
  });
  formAjustes.addEventListener("submit", () => {
    state.configIA.baseUrl = cfgBaseUrl.value || CONFIG_IA_DEFAULT.baseUrl;
    state.configIA.model = modeloElegido() || CONFIG_IA_DEFAULT.model;
    state.configIA.apiKey = cfgApiKey.value;
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardarAjustes();
    renderMonto();
    renderHojas();
  });
}
