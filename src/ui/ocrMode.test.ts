/* Tests P1: switch del modo OCR (DOM aislado). */
import { describe, expect, it } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

montarFixture();
const { state } = await import("../state");
const { initOcrMode, renderOcrToggle } = await import("./ocrMode");

const chkOcr = el<HTMLInputElement>("chkOcr");
const ocrEstado = el("ocrEstado");

initOcrMode();

function cambiar(checked: boolean): void {
  chkOcr.checked = checked;
  chkOcr.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("initOcrMode", () => {
  it("enciende: estado y ojo abierto", () => {
    cambiar(true);
    expect(state.modoOcr).toBe(true);
    expect(ocrEstado.classList.contains("on")).toBe(true);
  });

  it("apaga: ojo cerrado sin clase", () => {
    state.modoOcr = true;
    renderOcrToggle();
    cambiar(false);
    expect(state.modoOcr).toBe(false);
    expect(ocrEstado.classList.contains("on")).toBe(false);
  });

  it("change sin cambio real es no-op", () => {
    state.modoOcr = false;
    renderOcrToggle();
    cambiar(false);
    expect(state.modoOcr).toBe(false);
  });
});

describe("renderOcrToggle", () => {
  it("refleja el estado en ambos sentidos", () => {
    state.modoOcr = true;
    renderOcrToggle();
    expect(chkOcr.checked).toBe(true);
    expect(ocrEstado.classList.contains("on")).toBe(true);
    state.modoOcr = false;
    renderOcrToggle();
    expect(chkOcr.checked).toBe(false);
    expect(ocrEstado.classList.contains("on")).toBe(false);
  });
});
