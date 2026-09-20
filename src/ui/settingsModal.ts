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
  esNivelRazonamiento,
  etiquetaNivel,
  listarModelos,
  nivelesPara,
  probarConexion,
  sugeridosZenGo,
  urlProxy,
} from "../pipeline/modelos";
import type { NivelRazonamiento } from "../types";

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>("modalAjustes");
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnAjustes");
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>("formAjustes");
const cfgBaseUrl: HTMLInputElement = getEl<HTMLInputElement>("cfgBaseUrl");
const cfgModel: HTMLSelectElement = getEl<HTMLSelectElement>("cfgModel");
const cfgModelManual: HTMLInputElement = getEl<HTMLInputElement>("cfgModelManual");
const cfgRazonamiento: HTMLSelectElement = getEl<HTMLSelectElement>("cfgRazonamiento");
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

/** Generación de la prueba de conexión: descarta resoluciones rancias. */
let pruebaGen = 0;

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

/** Niveles según el modelo (3 o 6+No); conserva el actual si sigue válido. */
function pintarRazonamiento(modelo: string, actual: string): void {
  const niveles = nivelesPara(modelo);
  cfgRazonamiento.innerHTML = "";
  for (const n of niveles) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = etiquetaNivel(n);
    cfgRazonamiento.append(o);
  }
  cfgRazonamiento.value =
    actual.trim() !== "" && (niveles as string[]).includes(actual) ? actual : "auto";
}

function razonamientoElegido(): NivelRazonamiento {
  const v: unknown = cfgRazonamiento.value;
  return esNivelRazonamiento(v) ? v : "auto";
}

/** Repinta niveles tras cambiar de modelo sin perder el elegido si vale. */
function refrescarRazonamiento(): void {
  pintarRazonamiento(
    modeloElegido() || state.configIA.model,
    esNivelRazonamiento(cfgRazonamiento.value)
      ? cfgRazonamiento.value
      : (state.configIA.razonamiento ?? "auto"),
  );
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
  const gen = ++pruebaGen; // ponytail: la resolución rancia no pisa edición en vuelo
  const r = await probarConexion(
    base,
    key,
    modeloElegido() || CONFIG_IA_DEFAULT.model,
    fetch,
    razonamientoElegido(),
  );
  if (gen !== pruebaGen) return;
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
  if (!forzado && ultimaLista.length > 0) return; // ponytail: memoria viva, no del select (siempre >1 tras pintar)
  const sugeridos = sugeridosZenGo(base);
  btnRefrescarModelos.disabled = true;
  estadoModelosIA.textContent = `Modelos (${tipo}): cargando…`;
  try {
    const lista = await listarModelos(base, key);
    ultimaLista = lista;
    // ponytail: releer tras el await — el usuario pudo cambiar el modelo en vuelo
    pintarOpciones([...sugeridos, ...lista], modeloElegido() || state.configIA.model);
    refrescarRazonamiento();
    const total = new Set([...sugeridos, ...lista]).size;
    estadoModelosIA.textContent =
      total > 0
        ? `Modelos (${tipo}): ${total} disponibles.`
        : `Modelos (${tipo}): sin lista (revisá URL, clave, CORS).`;
  } catch (e: unknown) {
    // ponytail: releer tras el await (igual que en el éxito: pudo cambiar en vuelo)
    pintarOpciones([...sugeridos, ...ultimaLista], modeloElegido() || state.configIA.model);
    refrescarRazonamiento();
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
  pintarRazonamiento(state.configIA.model, state.configIA.razonamiento ?? "auto");
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
    refrescarRazonamiento();
    invalidarPrueba();
  });
  cfgModelManual.addEventListener("input", () => {
    refrescarRazonamiento();
    invalidarPrueba();
  });
  cfgRazonamiento.addEventListener("change", invalidarPrueba);
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
    state.configIA.baseUrl = cfgBaseUrl.value.trim() || CONFIG_IA_DEFAULT.baseUrl;
    state.configIA.model = modeloElegido().trim() || CONFIG_IA_DEFAULT.model;
    state.configIA.apiKey = cfgApiKey.value;
    state.configIA.razonamiento = razonamientoElegido();
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardarAjustes();
    renderMonto();
    renderHojas();
  });
}
