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
import { clearJevKey, getJevKey, probarJev, setJevKey } from "../pipeline/jev";

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
const btnBorrarApiKey: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarApiKey");
const cfgApiKey: HTMLInputElement = getEl<HTMLInputElement>("cfgApiKey");
const cfgJevKey: HTMLInputElement = getEl<HTMLInputElement>("cfgJevKey");
const btnConectarJev: HTMLButtonElement = getEl<HTMLButtonElement>("btnConectarJev");
const btnBorrarJev: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarJev");
const estadoJev: HTMLElement = getEl("estadoJev");
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnResetAjustes");
const estadoModelos: HTMLElement = getEl("estadoModelos");
const btnDescargarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargarModelos");
const btnBorrarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarModelos");

const MANUAL = "__manual__";

/** Última lista viva por endpoint: ante CORS se conserva en vez de vaciar el select. */
let cacheModelos: { endpoint: string; lista: string[] } = { endpoint: "", lista: [] };

/** Clave del caché: base sin espacios ni barras finales (como `detectarTipo`). */
function normalizarEndpoint(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** Generación de la prueba de conexión: descarta resoluciones rancias. */
let pruebaGen = 0;

/** Generación de la sonda JEV: descarta resoluciones rancias. */
let pruebaJevGen = 0;

/** Generación de la carga de modelos: descarta resoluciones rancias. */
let modelosGen = 0;

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
  // ponytail: recorte al leer — el pegado con espacios/ saltos rotos daba 401/CORS engañosos
  const base = cfgBaseUrl.value.trim() || CONFIG_IA_DEFAULT.baseUrl;
  const key = cfgApiKey.value.trim();
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
    estadoPruebaIA.dataset.estado = "ok";
    cfgApiKey.setAttribute("aria-invalid", "false");
  } else {
    estadoPruebaIA.textContent = `✗ ${r.mensaje}`;
    estadoPruebaIA.dataset.estado = "error";
    cfgApiKey.setAttribute("aria-invalid", "true");
  }
  btnProbarIA.disabled = cfgApiKey.value.trim() === "";
}

/** Cambio en endpoint/key/modelo invalida la última prueba (y su vuelo). */
function invalidarPrueba(): void {
  ++pruebaGen;
  estadoPruebaIA.textContent = "Sin probar.";
  delete estadoPruebaIA.dataset.estado;
  cfgApiKey.removeAttribute("aria-invalid");
}

async function cargarModelos(forzado: boolean): Promise<void> {
  const base = cfgBaseUrl.value.trim() || CONFIG_IA_DEFAULT.baseUrl;
  const key = cfgApiKey.value.trim();
  const tipo = detectarTipo(base);
  if (key.trim() === "") {
    estadoModelosIA.textContent = `Modelos (${tipo}): falta API key.`;
    btnRefrescarModelos.disabled = true;
    return;
  }
  btnRefrescarModelos.disabled = false;
  // ponytail: caché por endpoint — la lista de otro proveedor no se reutiliza
  if (
    !forzado &&
    cacheModelos.lista.length > 0 &&
    cacheModelos.endpoint === normalizarEndpoint(base)
  )
    return;
  const sugeridos = sugeridosZenGo(base);
  btnRefrescarModelos.disabled = true;
  estadoModelosIA.textContent = `Modelos (${tipo}): cargando…`;
  const gen = ++modelosGen; // ponytail: la resolución rancia no pisa (igual que la prueba)
  try {
    const lista = await listarModelos(base, key);
    if (gen !== modelosGen) return;
    cacheModelos = { endpoint: normalizarEndpoint(base), lista };
    // ponytail: releer tras el await — el usuario pudo cambiar el modelo en vuelo
    pintarOpciones([...sugeridos, ...lista], modeloElegido() || state.configIA.model);
    refrescarRazonamiento();
    const total = new Set([...sugeridos, ...lista]).size;
    estadoModelosIA.textContent =
      total > 0
        ? `Modelos (${tipo}): ${total} disponibles.`
        : `Modelos (${tipo}): sin lista (revisá URL, clave, CORS).`;
  } catch (e: unknown) {
    if (gen !== modelosGen) return;
    // ponytail: releer tras el await (igual que en el éxito: pudo cambiar en vuelo)
    // ponytail: el caché ajeno no se ofrece — es del endpoint viejo, no de `base`
    const cache = cacheModelos.endpoint === normalizarEndpoint(base) ? cacheModelos.lista : [];
    pintarOpciones([...sugeridos, ...cache], modeloElegido() || state.configIA.model);
    refrescarRazonamiento();
    const causa = e instanceof Error ? e.message : "error";
    estadoModelosIA.textContent = causa.includes("CORS")
      ? `Modelos (${tipo}): el servidor no lista desde navegador; elegí sugerido o pegá el ID manual. (${causa})`
      : `Modelos (${tipo}): no se pudo listar (${causa}).`;
  } finally {
    if (gen === modelosGen) btnRefrescarModelos.disabled = key.trim() === "";
  }
}

function pintarJev(): void {
  cfgJevKey.value = getJevKey();
  estadoJev.textContent = getJevKey() !== "" ? "Guardada ✓" : "Sin key (modo local)";
  delete estadoJev.dataset.estado;
  cfgJevKey.removeAttribute("aria-invalid");
  btnConectarJev.disabled = getJevKey() === "";
}

/** Sonda JEV real (1 inferencia mínima): verifica, guarda, mide ms y pinta ✓/✗. Nunca lanza. */
async function probarConexionJevUI(): Promise<void> {
  // ponytail: recorte al leer — igual que la key del LLM en probarConexionUI
  const key = cfgJevKey.value.trim();
  if (key === "") {
    estadoJev.textContent = "Falta API key JEV.";
    btnConectarJev.disabled = true;
    return;
  }
  btnConectarJev.disabled = true;
  estadoJev.textContent = "Conectando…";
  cfgJevKey.removeAttribute("aria-invalid");
  const gen = ++pruebaJevGen; // ponytail: la resolución rancia no pisa edición en vuelo
  const r = await probarJev(key);
  if (gen !== pruebaJevGen) return;
  if (r.ok) {
    setJevKey(key); // solo la key verificada persiste (la mala no contamina el store)
    estadoJev.textContent = `✓ OK (${r.modelo}, ${r.ms}ms).`;
    estadoJev.dataset.estado = "ok";
    cfgJevKey.setAttribute("aria-invalid", "false");
  } else {
    estadoJev.textContent = `✗ ${r.mensaje}`;
    estadoJev.dataset.estado = "error";
    cfgJevKey.setAttribute("aria-invalid", "true");
  }
  btnConectarJev.disabled = cfgJevKey.value.trim() === "";
}

/** Cambio en la key JEV invalida la última prueba (y su vuelo). */
function invalidarJev(): void {
  ++pruebaJevGen;
  estadoJev.textContent = "Sin probar.";
  delete estadoJev.dataset.estado;
  cfgJevKey.removeAttribute("aria-invalid");
}

function pintarAjustes(): void {
  cfgBaseUrl.value = state.configIA.baseUrl;
  cfgApiKey.value = state.configIA.apiKey;
  pintarJev();
  cfgMoneda.value = state.moneda;
  cfgModelManual.value = "";
  // ponytail: el caché es por endpoint — el de otro proveedor no se mezcla
  const cache =
    cacheModelos.endpoint === normalizarEndpoint(state.configIA.baseUrl) ? cacheModelos.lista : [];
  pintarOpciones([...sugeridosZenGo(state.configIA.baseUrl), ...cache], state.configIA.model);
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
  cfgBaseUrl.addEventListener("input", () => {
    ++modelosGen; // la lista en vuelo es del endpoint viejo
    invalidarPrueba();
  });
  cfgApiKey.addEventListener("input", () => {
    ++modelosGen; // la lista en vuelo es de la key vieja
    btnRefrescarModelos.disabled = cfgApiKey.value.trim() === "";
    btnProbarIA.disabled = cfgApiKey.value.trim() === "";
    invalidarPrueba();
  });
  btnProbarIA.addEventListener("click", () => {
    void probarConexionUI();
  });
  // ponytail: vaciar + evento input reutiliza el listener (deshabilita, invalida).
  // Solo prepara el borrado: el Guardar grande lo confirma (igual que la key).
  btnBorrarApiKey.addEventListener("click", () => {
    cfgApiKey.value = "";
    cfgApiKey.dispatchEvent(new Event("input", { bubbles: true }));
  });
  btnConectarJev.addEventListener("click", () => {
    void probarConexionJevUI();
  });
  cfgJevKey.addEventListener("input", () => {
    btnConectarJev.disabled = cfgJevKey.value.trim() === "";
    invalidarJev();
  });
  btnBorrarJev.addEventListener("click", () => {
    clearJevKey();
    pintarJev();
  });
  btnRefrescarModelos.addEventListener("click", () => {
    void cargarModelos(true);
  });
  btnResetAjustes.addEventListener("click", () => {
    restablecerAjustes();
    clearJevKey(); // Predeterminado también apaga el gasto JEV (no vive en state)
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
    state.configIA.apiKey = cfgApiKey.value.trim();
    setJevKey(cfgJevKey.value); // el Guardar grande también guarda la key JEV
    state.configIA.razonamiento = razonamientoElegido();
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardarAjustes();
    renderMonto();
    renderHojas();
  });
}
