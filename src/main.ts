/* Bootstrap: carga estado, cablea módulos y pinta el primer frame. */
import { cargar, crearHoja, state } from "./state";
import { initSheets } from "./ui/sheets";
import { agregarArchivos, elegirArchivos, initSidebar, renderCodigo } from "./ui/sidebar";
import { initOcrMode, renderOcrToggle } from "./ui/ocrMode";
import { initSettings } from "./ui/settingsModal";
import { initGithub } from "./ui/github";
import { initRecorte } from "./ui/recorte";
import { initExport } from "./export/salidas";
import { renderHojas } from "./ui/sheets";
import { getEl } from "./utils";

const TEMA_KEY = "libro-mayor-tema";
const btnTema: HTMLButtonElement = getEl<HTMLButtonElement>("btnTema");

function aplicarTema(tema: string): void {
  document.documentElement.dataset["tema"] = tema;
  btnTema.title = tema === "claro" ? "Cambiar a oscuro" : "Cambiar a claro";
}

function resolverTema(): "claro" | "oscuro" {
  const guardado = localStorage.getItem(TEMA_KEY);
  if (guardado === "claro" || guardado === "oscuro") return guardado;
  // ponytail: doble query explícita — sin matchMedia o sin coincidencia
  // (modo desconocido) el default es claro, no oscuro.
  if (typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-color-scheme: light)").matches) return "claro";
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "oscuro";
  }
  return "claro";
}

function initTema(): void {
  aplicarTema(resolverTema());
}

cargar();
initTema();
if (state.hojas.length === 0) state.hojas.push(crearHoja());
initSheets({ agregarArchivos, pedirArchivos: elegirArchivos });
initSidebar();
initOcrMode();
initSettings();
initRecorte();
initExport();
void initGithub();
btnTema.addEventListener("click", () => {
  const nuevo = document.documentElement.dataset["tema"] === "claro" ? "oscuro" : "claro";
  localStorage.setItem(TEMA_KEY, nuevo);
  aplicarTema(nuevo);
});
renderCodigo();
renderHojas();
renderOcrToggle();
