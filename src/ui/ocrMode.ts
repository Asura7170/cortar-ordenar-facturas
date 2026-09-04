/* Modo OCR: las casillas muestran el texto OCR en vez de la imagen. */
import { state } from "../state";
import { renderHojas } from "./sheets";
import { getEl } from "../utils";

const chkOcr: HTMLInputElement = getEl<HTMLInputElement>("chkOcr");
const ocrEstado: HTMLElement = getEl("ocrEstado");

export function renderOcrToggle(): void {
  chkOcr.checked = state.modoOcr;
  ocrEstado.textContent = state.modoOcr ? "ON" : "OFF";
  ocrEstado.classList.toggle("on", state.modoOcr);
}

export function initOcrMode(): void {
  chkOcr.addEventListener("change", () => {
    if (chkOcr.checked === state.modoOcr) return;
    state.modoOcr = !state.modoOcr;
    renderOcrToggle();
    renderHojas();
  });
}
