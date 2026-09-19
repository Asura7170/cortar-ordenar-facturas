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
import {
  detectarTipo,
  listarModelos,
  probarConexion,
  sugeridosZenGo,
  urlProxy,
} from "../pipeline/modelos";

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>("modalAjustes");
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnAjustes");
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>("formAjustes");
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>("cfgBaseUrl");
const cfgModel: HTMLSelectElement = getEl<HTMLSelectElement>("cfgModel");
const cfgModelManual: HTMLInputElement = getEl<HTMLInputElement>("cfgModelManual");
const btnRefrescarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnRefrescarModelos");
const estadoModelosIA: HTMLElement = getEl("estadoModelosIA");
const btnProbarIA: HTMLButtonElement = getEl<HTMLButtonElement>("btnProbarIA");
const estadoPruebaIA: HTMLElement = getEl("estadoPruebaIA");
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>("cfgApiKey");
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnResetAjustes");
const estadoModelos: HTMLElement = getEl("estadoModelos");
const btnDescargarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargarModelos");
const btnBorrarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarModelos");

const MANUAL = "__manual__";

/** Última lista viva: ante CORS se conserva en vez de vaciar el select. */
let ultimaLista: string[] = [];

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

/** POST mínimo: verifica endpoint+key+modelo sin gastar. Nunca lanza. */
async function probarConexionUI(): Promise<void> {
  const base = cfgBaseUrl.value || CONFIG_IA_DEFAULT.baseUrl;
  const key = cfgApiKey.value;
  if (key.trim() === "") {
    estadoPruebaIA.textContent = "Falta API key.";
    btnProbarIA.disabled = true;
    return;
  }
  btnProbarIA.disabled = true;
  estadoPruebaIA.textContent = `Probando (${detectarTipo(base)})…`;
  cfgApiKey.removeAttribute("aria-invalid");
  const r = await probarConexion(base, key, modeloElegido() || CONFIG_IA_DEFAULT.model);
  if (r.ok) {
    const via = urlProxy(base) !== base ? ", proxy dev" : "";
    estadoPruebaIA.textContent = `✓ OK (${r.tipo}${via}, ${r.ms}ms).`;
    cfgApiKey.setAttribute("aria-invalid", "false");
  } else {
    estadoPruebaIA.textContent = `✗ ${r.mensaje}`;
    cfgApiKey.setAttribute("aria-invalid", "true");
  }
  btnProbarIA.disabled = cfgApiKey.value.trim() === "";
}

/** Cambio en endpoint/key/modelo invalida la última prueba. */
function invalidarPrueba(): void {
  estadoPruebaIA.textContent = "Sin probar.";
  cfgApiKey.removeAttribute("aria-invalid");
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
  const sugeridos = sugeridosZenGo(base);
  btnRefrescarModelos.disabled = true;
  estadoModelosIA.textContent = `Modelos (${tipo}): cargando…`;
  try {
    const lista = await listarModelos(base, key);
    ultimaLista = lista;
    pintarOpciones([...sugeridos, ...lista], actual);
    const total = new Set([...sugeridos, ...lista]).size;
    estadoModelosIA.textContent =
      total > 0
        ? `Modelos (${tipo}): ${total} disponibles.`
        : `Modelos (${tipo}): sin lista (revisá URL, clave, CORS).`;
  } catch (e: unknown) {
    pintarOpciones([...sugeridos, ...ultimaLista], actual);
    const causa = e instanceof Error ? e.message : "error";
    estadoModelosIA.textContent = causa.includes("CORS")
      ? `Modelos (${tipo}): el servidor no lista desde navegador; elegí sugerido o pegá el ID manual. (${causa})`
      : `Modelos (${tipo}): no se pudo listar (${causa}).`;
  } finally {
    btnRefrescarModelos.disabled = key.trim() === "";
  }
}

function pintarAjustes(): void {
  cfgBaseUrl.value = state.configIA.baseUrl;
  cfgApiKey.value = state.configIA.apiKey;
  cfgMoneda.value = state.moneda;
  cfgModelManual.value = "";
  pintarOpciones([...sugeridosZenGo(state.configIA.baseUrl), ...ultimaLista], state.configIA.model);
  estadoPruebaIA.textContent = "Sin probar.";
  cfgApiKey.removeAttribute("aria-invalid");
  btnProbarIA.disabled = state.configIA.apiKey.trim() === "";
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
    invalidarPrueba();
  });
  cfgModelManual.addEventListener("input", invalidarPrueba);
  cfgBaseUrl.addEventListener("input", invalidarPrueba);
  cfgApiKey.addEventListener("input", () => {
    btnRefrescarModelos.disabled = cfgApiKey.value.trim() === "";
    btnProbarIA.disabled = cfgApiKey.value.trim() === "";
    invalidarPrueba();
  });
  btnProbarIA.addEventListener("click", () => {
    void probarConexionUI();
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
