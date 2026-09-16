/* Tests: recorte.ts — editor manual con tiradores, commit + relectura. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { el, montarFixture } from "../test/fixture";

// El render real necesita grilla; los tests asertan estado, no DOM.
vi.mock("./sheets", () => ({ renderHojas: vi.fn() }));
// Sin onnx en jsdom: texto stub (el commit del lienzo sigue real).
vi.mock("../pipeline/ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/ocr")>();
  return { ...real, extraerTexto: vi.fn(async () => "TOTAL LEÍDO") };
});
// El lote post-recorte no debe pegar a la red en tests.
vi.mock("../pipeline/extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));
// Thumb controlable por test (asignarMiniatura sigue real).
vi.mock("../pipeline/queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/queue")>();
  return { ...real, generarMiniatura: vi.fn(async () => "blob:thumb") };
});

montarFixture();
const { crearHoja, state } = await import("../state");
const { abrirRecorte, initRecorte } = await import("./recorte");
const { extraerTexto } = await import("../pipeline/ocr");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("./sheets");

const modal = el<HTMLDialogElement>("modalRecorte");
const guia = el<HTMLCanvasElement>("recorteGuia");
const btnOk = el<HTMLButtonElement>("btnRecorteOk");

initRecorte();

/** Contexto 2d falso (jsdom no implementa canvas). */
function ctxFalso(): Record<string, unknown> {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    drawImage: vi.fn(),
    imageSmoothingQuality: "high",
  };
}

/** Bitmap + lienzo falsos (suficiente para el commit real). */
function depsRecorte(
  w = 100,
  h = 80,
): {
  bmp: { width: number; height: number; close: () => void };
  creados: { width: number; height: number }[];
  deps: { cargar: () => Promise<unknown>; crear: () => unknown };
} {
  const bmp = { width: w, height: h, close: vi.fn() };
  const creados: { width: number; height: number }[] = [];
  return {
    bmp,
    creados,
    deps: {
      cargar: vi.fn(async () => bmp),
      crear: vi.fn(() => {
        const lienzo = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["recorte"])),
        };
        creados.push(lienzo);
        return lienzo;
      }),
    },
  };
}

function sembrar(): ReturnType<typeof comprobante> {
  const h = crearHoja();
  const c = comprobante({
    estado: "ok",
    montoCents: 123,
    textoOcr: "VIEJO",
    file: new Blob(["foto"]),
  });
  h.slots[0] = c;
  state.hojas.push(h);
  return c;
}

/** Espera a que los handlers void (click → confirmar) terminen. */
async function vaciar(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** PointerEvent sintético (jsdom no trae constructor útil). */
function puntero(tipo: string, x: number, y: number): Event {
  const e = new Event(tipo, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clientX", { value: x });
  Object.defineProperty(e, "clientY", { value: y });
  Object.defineProperty(e, "isPrimary", { value: true });
  Object.defineProperty(e, "pointerId", { value: 1 });
  Object.defineProperty(e, "button", { value: 0 });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  return e;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(extraerTexto).mockClear();
  vi.mocked(renderHojas).mockClear();
  if (modal.open) modal.close();
  state.hojas.length = 0;
});

describe("abrirRecorte", () => {
  it("no-op sin item o sin estado ok", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps } = depsRecorte();
      await abrirRecorte(999999, deps as never);
      const c = sembrar();
      c.estado = "pendiente";
      await abrirRecorte(c.id, deps as never);
      expect(modal.open).toBe(false);
      expect(deps.cargar).not.toHaveBeenCalled();
    } finally {
      ctx.mockRestore();
    }
  });

  it("confirmar con rect completo commitea el recorte y relee", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte();
      const c = sembrar();
      const antes = c.file;
      await abrirRecorte(c.id, deps as never);
      expect(modal.open).toBe(true);
      btnOk.click();
      await vaciar();
      // Rect inicial = imagen completa (100x80 naturales, escala 1).
      expect(creados[0]).toMatchObject({ width: 100, height: 80 });
      expect(c.file).not.toBe(antes);
      expect(c.file).toBeInstanceOf(Blob);
      expect(c.textoOcr).toBe("TOTAL LEÍDO");
      expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(1);
      expect(modal.open).toBe(false);
      expect(vi.mocked(renderHojas)).toHaveBeenCalled();
    } finally {
      ctx.mockRestore();
    }
  });

  it("el tirador nunca sale de la imagen (arrastre sobredimensionado)", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte();
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      // Tirador "se" en (100,80); se arrastra muy fuera.
      guia.dispatchEvent(puntero("pointerdown", 100, 80));
      guia.dispatchEvent(puntero("pointermove", 9999, 9999));
      guia.dispatchEvent(puntero("pointerup", 9999, 9999));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 100, height: 80 });
    } finally {
      ctx.mockRestore();
    }
  });

  it("abre desde el previo pre-warp y confirmar lo limpia", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps } = depsRecorte();
      const c = sembrar();
      const previo = new Blob(["previo"]);
      c.previoDocAligner = previo;
      await abrirRecorte(c.id, deps as never);
      expect(modal.open).toBe(true);
      expect(deps.cargar).toHaveBeenCalledWith(previo);
      btnOk.click();
      await vaciar();
      expect(c.previoDocAligner).toBeUndefined();
      expect(c.file).toBeInstanceOf(Blob);
    } finally {
      ctx.mockRestore();
    }
  });

  it("cerrar sin confirmar no toca el comprobante", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, bmp } = depsRecorte();
      const c = sembrar();
      const antes = c.file;
      await abrirRecorte(c.id, deps as never);
      expect(modal.open).toBe(true);
      modal.close(); // Escape/native: el evento close limpia
      expect(c.file).toBe(antes);
      expect(c.textoOcr).toBe("VIEJO");
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(bmp.close).toHaveBeenCalled(); // bitmap liberado
    } finally {
      ctx.mockRestore();
    }
  });
});
