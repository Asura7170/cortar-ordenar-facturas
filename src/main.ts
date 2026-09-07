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
