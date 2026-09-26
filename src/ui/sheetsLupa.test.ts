/* Tests: dibujarLupa con ctx 2d mockeado (jsdom no trae canvas).
   El módulo captura lupaCtx al importarse: el mock va antes del import dinámico. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

montarFixture();

const ctx = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  imageSmoothingEnabled: false,
  imageSmoothingQuality: "low",
};
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
  ctx as unknown as CanvasRenderingContext2D,
);

const { crearHoja, state } = await import("../state");
const { initSheets, renderHojas } = await import("./sheets");
const { comprobante } = await import("../test/factoria");

initSheets({ agregarArchivos: vi.fn(), pedirArchivos: vi.fn() });

afterEach(() => {
  const btn = el<HTMLButtonElement>("btnLupa");
  if (btn.getAttribute("aria-pressed") === "true") btn.click();
  ctx.clearRect.mockClear();
  ctx.fillRect.mockClear();
  ctx.drawImage.mockClear();
});

function moverLupa(x: number, y: number): void {
  el("canvas").dispatchEvent(
    Object.assign(new Event("pointermove", { bubbles: true }), { clientX: x, clientY: y }),
  );
}

async function vaciar(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60));
}

describe("dibujarLupa", () => {
  it("fuera de foto amplía el fondo plano", async () => {
    // Punto sobre un panel: primero transparente (sube al raíz y cae a #000),
    // luego rojo (el fondo se resuelve en el propio nodo).
    const panel = document.createElement("div");
    panel.style.backgroundColor = "transparent";
    document.body.appendChild(panel);
    Object.defineProperty(document, "elementFromPoint", {
      value: vi.fn(() => panel),
      configurable: true,
    });
    try {
      const h = crearHoja("u1");
      h.slots[0] = comprobante({ estado: "ok", montoCents: 100 });
      state.hojas.push(h);
      renderHojas();
      el<HTMLButtonElement>("btnLupa").click();
      moverLupa(300, 300);
      await vaciar();
      panel.style.backgroundColor = "rgb(255, 0, 0)";
      moverLupa(310, 310);
      await vaciar();
      expect(ctx.clearRect).toHaveBeenCalled();
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 200);
      expect(ctx.drawImage).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>)["elementFromPoint"];
      panel.remove();
    }
  });

  it("sobre la foto dibuja la muestra ampliada", async () => {
    const h = crearHoja("u1");
    h.slots[0] = comprobante({ estado: "ok", montoCents: 100 });
    state.hojas.push(h);
    renderHojas();
    const cell = document.querySelector(".cell");
    const img = cell?.querySelector("img");
    if (!(cell instanceof HTMLElement) || !(img instanceof HTMLImageElement))
      throw new Error("sin celda con imagen");
    Object.defineProperty(img, "naturalWidth", { value: 100, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 100, configurable: true });
    const rect = vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(document, "elementFromPoint", {
      value: vi.fn(() => cell),
      configurable: true,
    });
    try {
      el<HTMLButtonElement>("btnLupa").click();
      moverLupa(50, 50);
      await vaciar();
      expect(ctx.drawImage).toHaveBeenCalled();
    } finally {
      rect.mockRestore();
      delete (document as unknown as Record<string, unknown>)["elementFromPoint"];
    }
  });
});
