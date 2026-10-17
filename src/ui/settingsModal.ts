/* Modal de ajustes: moneda (persiste) + gestión de modelos locales (OCR). */
import { MONEDA_DEFAULT, guardarAjustes, isMoneda, restablecerAjustes, state } from "../state";
import { renderMonto } from "./monto";
import { renderHojas } from "./sheets";
import { getEl, esImportDinamicoMuerto } from "../utils";
import {
  borrarModelos,
  descargarPesos,
  obtenerSesion,
  reactivarIa,
  tamanoModelos,
} from "../pipeline/docaligner";
import { descargarPesosOcr, obtenerNucleo } from "../pipeline/ocr";

const modalAjustes: HTMLDialogElement = getEl<HTMLDialogElement>("modalAjustes");
const btnAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnAjustes");
const formAjustes: HTMLFormElement = getEl<HTMLFormElement>("formAjustes");
const cfgMoneda: HTMLSelectElement = getEl<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes: HTMLButtonElement = getEl<HTMLButtonElement>("btnResetAjustes");
const estadoModelos: HTMLElement = getEl("estadoModelos");
const btnDescargarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargarModelos");
const btnProbarIa: HTMLButtonElement = getEl<HTMLButtonElement>("btnProbarIa");
const btnBorrarModelos: HTMLButtonElement = getEl<HTMLButtonElement>("btnBorrarModelos");

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

/** Exclusión mutua del fieldset Modelos: Probar/Descargar/Borrar demoran minutos
    y se pisaban (Borrar corría contra descargas en vuelo, finallys ajenos). */
let modelosOcupado = false;

function ocuparModelos(): boolean {
  if (modelosOcupado) return false;
  modelosOcupado = true;
  btnProbarIa.disabled = true;
  btnDescargarModelos.disabled = true;
  btnBorrarModelos.disabled = true;
  return true;
}

function soltarModelos(): void {
  modelosOcupado = false;
  btnProbarIa.disabled = false;
  btnDescargarModelos.disabled = false;
  btnBorrarModelos.disabled = false;
}

function pintarAjustes(): void {
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
  btnProbarIa.addEventListener("click", () => {
    if (!ocuparModelos()) return;
    reactivarIa(); // sin enfriamiento ni latch de EPs: la prueba nace fresca
    estadoModelos.textContent = "IA: probando (descarga y sesiones GPU)…";
    void (async (): Promise<void> => {
      try {
        await obtenerSesion(); // recorte: fastvit
        await obtenerNucleo(); // OCR: det+rec (en serie: la GPU no compite)
        estadoModelos.textContent = "IA: sesiones listas — recorte y OCR van bien";
      } catch (e: unknown) {
        const msj = e instanceof Error ? e.message : String(e);
        estadoModelos.textContent = esImportDinamicoMuerto(msj)
          ? "IA: sin archivos de la app (recargá el navegador — hay versión nueva)"
          : `IA: no disponible (${msj}). Probá de nuevo o borrá los modelos`;
      } finally {
        soltarModelos();
      }
    })();
  });
  btnDescargarModelos.addEventListener("click", () => {
    if (!ocuparModelos()) return;
    estadoModelos.textContent = "Modelos: descargando…";
    void Promise.all([descargarPesos(), descargarPesosOcr()])
      .then(
        () => pintarModelos(),
        (e: unknown) => {
          console.warn("modelos:", e);
          estadoModelos.textContent =
            "Modelos: no se pudo descargar: falta espacio o conexión. Probá de nuevo";
        },
      )
      .finally(() => soltarModelos());
  });
  btnBorrarModelos.addEventListener("click", () => {
    if (!ocuparModelos()) return;
    void borrarModelos()
      .then(
        (habia) => {
          estadoModelos.textContent = habia
            ? "Modelos: borrados (se descargan de nuevo al usarse)"
            : "Modelos: no había nada descargado";
        },
        (e: unknown) => {
          console.warn("modelos:", e);
          estadoModelos.textContent =
            "Modelos: no se pudo borrar: hay algo bloqueando el almacenamiento. Probá de nuevo";
        },
      )
      .finally(() => soltarModelos());
  });
  formAjustes.addEventListener("submit", () => {
    state.moneda = isMoneda(cfgMoneda.value) ? cfgMoneda.value : MONEDA_DEFAULT;
    guardarAjustes();
    renderMonto();
    renderHojas();
  });
}
