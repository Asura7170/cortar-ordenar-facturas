/* Bootstrap: carga estado, cablea módulos y pinta el primer frame. */
import { cargar, crearHoja, state } from "./state";
import { initSheets } from "./ui/sheets";
import { agregarArchivos, initSidebar, renderCodigo } from "./ui/sidebar";
import { initOcrMode, renderOcrToggle } from "./ui/ocrMode";
import { initSettings } from "./ui/settingsModal";
import { initExport } from "./export/docx";
import { renderHojas } from "./ui/sheets";
import { getEl } from "./utils";

const TEMA_KEY = "libro-mayor-tema";
const btnTema: HTMLButtonElement = getEl<HTMLButtonElement>("btnTema");
const temaIcono: HTMLElement = getEl("temaIcono");

function aplicarTema(tema: string): void {
  document.documentElement.dataset["tema"] = tema;
  temaIcono.textContent = tema === "claro" ? "☀" : "☾";
  btnTema.title = tema === "claro" ? "Cambiar a oscuro" : "Cambiar a claro";
}

function initTema(): void {
  const guardado = localStorage.getItem(TEMA_KEY);
  if (guardado) {
    aplicarTema(guardado);
    return;
  }
  const prefiereClaro = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  aplicarTema(prefiereClaro ? "claro" : "oscuro");
}

cargar();
if (state.hojas.length === 0) state.hojas.push(crearHoja());
initSheets({ agregarArchivos });
initSidebar();
initOcrMode();
initSettings();
initExport();
btnTema.addEventListener("click", () => {
  const nuevo = document.documentElement.dataset["tema"] === "claro" ? "oscuro" : "claro";
  localStorage.setItem(TEMA_KEY, nuevo);
  aplicarTema(nuevo);
});
renderCodigo();
renderHojas();
renderOcrToggle();
initTema();

// Precarga: descarga+compila los 3 modelos en idle tras el primer frame.
// El primer comprobante no los espera; si el usuario sube antes de que
// termine, los singletons dedupplican (misma promesa, cero doble trabajo).
// Si falla (offline), los singletons reintentan en el uso real.
// Con ahorro de datos no se precarga (son ~60MB la primera visita).
const conexion = navigator as Navigator & { connection?: { saveData?: boolean } };
if (!conexion.connection?.saveData) {
  const precargar = (): void => {
    void import("./pipeline/docaligner").then((m) => m.obtenerSesion().catch((): null => null));
    void import("./pipeline/ocr").then((m) => m.obtenerNucleo().catch((): null => null));
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(precargar, { timeout: 3000 });
  else setTimeout(precargar, 1000);
}
