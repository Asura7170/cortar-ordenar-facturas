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

// ponytail: pura e inyectada para testear sin arrancar el bootstrap.
export function resolverTema(
  guardado: string | null,
  luz: boolean,
  oscuridad: boolean,
): "claro" | "oscuro" {
  if (guardado === "claro" || guardado === "oscuro") return guardado;
  if (luz) return "claro";
  if (oscuridad) return "oscuro";
  // Sin matchMedia o sin coincidencia (modo desconocido) el default es claro.
  return "claro";
}

function leerTemaGuardado(): string | null {
  try {
    return localStorage.getItem(TEMA_KEY);
  } catch {
    return null; // almacenamiento bloqueado: cae al SO/default, nunca aborta el boot
  }
}

function initTema(): void {
  const mm =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia.bind(window)
      : null;
  aplicarTema(
    resolverTema(
      leerTemaGuardado(),
      mm?.("(prefers-color-scheme: light)").matches ?? false,
      mm?.("(prefers-color-scheme: dark)").matches ?? false,
    ),
  );
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
