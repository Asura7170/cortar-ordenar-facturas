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
  // Viewport fijo: la escala de llenado es determinista (768 → maxH 479.76).
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
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
      // Marco de 6px por lado: 100x80 llenan a 585x468 (k=5.847).
      expect(el<HTMLCanvasElement>("recorteBase").width).toBe(585 + 12);
      expect(el<HTMLCanvasElement>("recorteBase").height).toBe(468 + 12);
      btnOk.click();
      await vaciar();
      // Rect inicial = imagen completa (100x80 naturales).
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

  it("abre desde el previo pre-warp y confirmar lo conserva", async () => {
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
      // El previo sobrevive: la próxima sesión puede volver a ensanchar.
      expect(c.previoDocAligner).toBe(previo);
      expect(c.file).toBeInstanceOf(Blob);
    } finally {
      ctx.mockRestore();
    }
  });

  it("clic en el velo cierra; clic dentro no", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps } = depsRecorte();
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      expect(modal.open).toBe(true);
      guia.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(modal.open).toBe(true); // dentro: sigue abierto
      modal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(modal.open).toBe(false); // velo (target = dialog): cierra
      expect(state.cierreRecorte).toBeGreaterThan(0);
      expect(c.file).toBeDefined(); // cerrar no commitea
    } finally {
      ctx.mockRestore();
      state.cierreRecorte = 0;
    }
  });

  it("agarra en plena línea lejos de tiradores", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      // Borde superior en x=60 (lejos de tiradores): mueve el lado norte.
      guia.dispatchEvent(puntero("pointerdown", 60, 6));
      guia.dispatchEvent(puntero("pointermove", 60, 30));
      guia.dispatchEvent(puntero("pointerup", 60, 30));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 200, height: 75 });
    } finally {
      ctx.mockRestore();
    }
  });

  it("esquina generosa: agarra a ~31px del vértice", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      // A 31px del vértice "no" (fuera de los 22px viejos): igual agarra.
      guia.dispatchEvent(puntero("pointerdown", 28, 28));
      guia.dispatchEvent(puntero("pointermove", 50, 50));
      guia.dispatchEvent(puntero("pointerup", 50, 50));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 190, height: 70 });
    } finally {
      ctx.mockRestore();
    }
  });

  it("arrastrar el interior mueve sin redimensionar", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      const antes = c.file;
      await abrirRecorte(c.id, deps as never);
      // Se achica por la esquina "se" (854,345 con llenado) y se mueve por el interior.
      guia.dispatchEvent(puntero("pointerdown", 916, 370));
      guia.dispatchEvent(puntero("pointermove", 400, 200));
      guia.dispatchEvent(puntero("pointerup", 400, 200));
      guia.dispatchEvent(puntero("pointerdown", 203, 103));
      guia.dispatchEvent(puntero("pointermove", 260, 140));
      guia.dispatchEvent(puntero("pointerup", 260, 140));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 87, height: 43 });
      expect(c.file).not.toBe(antes);
    } finally {
      ctx.mockRestore();
    }
  });

  it("mover más allá del borde fija el área al filo", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      guia.dispatchEvent(puntero("pointerdown", 916, 370));
      guia.dispatchEvent(puntero("pointermove", 400, 200));
      guia.dispatchEvent(puntero("pointerup", 400, 200));
      guia.dispatchEvent(puntero("pointerdown", 203, 103));
      guia.dispatchEvent(puntero("pointermove", 9999, 9999));
      guia.dispatchEvent(puntero("pointerup", 9999, 9999));
      btnOk.click();
      await vaciar();
      // Fijado abajo-derecha: mismo tamaño, sin salirse.
      expect(creados[0]).toMatchObject({ width: 87, height: 43 });
    } finally {
      ctx.mockRestore();
    }
  });

  it("achicar al mínimo con upscale commitea (mínimo en ambas unidades)", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      const antes = c.file;
      await abrirRecorte(c.id, deps as never);
      // Sin el mínimo natural, 24 display ≈ 5 naturales y confirmar rechaza.
      guia.dispatchEvent(puntero("pointerdown", 916, 370));
      guia.dispatchEvent(puntero("pointermove", 30, 30));
      guia.dispatchEvent(puntero("pointerup", 30, 30));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 8, height: 8 });
      expect(c.file).not.toBe(antes);
      expect(modal.open).toBe(false);
    } finally {
      ctx.mockRestore();
    }
  });

  it("recortar tras girar cancela la relectura rancia del giro", async () => {
    vi.useFakeTimers();
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { girarYReleer } = await import("../pipeline/rotar");
      const bmpGiro = { width: 100, height: 80, close: vi.fn() };
      const depsGiro = {
        cargar: vi.fn(async () => bmpGiro),
        crear: vi.fn(() => ({
          width: 0,
          height: 0,
          getContext: () => ({ setTransform: vi.fn(), drawImage: vi.fn() }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
        })),
      };
      const c = sembrar();
      await girarYReleer(c.id, 90, depsGiro as never);
      // Timer del giro pendiente: el OCR aún no corrió.
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      const { deps } = depsRecorte();
      await abrirRecorte(c.id, deps as never);
      btnOk.click();
      await vi.advanceTimersByTimeAsync(2000); // vence el debounce del giro
      // Solo la relectura inmediata del recorte (sin fix serían 2).
      expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(1);
      expect(c.textoOcr).toBe("TOTAL LEÍDO");
    } finally {
      ctx.mockRestore();
      vi.useRealTimers();
    }
  });

  it("doble clic en Recortar commitea una sola vez", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte();
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      btnOk.click();
      btnOk.click();
      await vaciar();
      expect(creados).toHaveLength(1);
      expect(c.file).toBeInstanceOf(Blob);
    } finally {
      ctx.mockRestore();
    }
  });

  it("doble apertura concurrente decodifica una sola vez", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps } = depsRecorte();
      const c = sembrar();
      const p1 = abrirRecorte(c.id, deps as never);
      const p2 = abrirRecorte(c.id, deps as never);
      await Promise.all([p1, p2]);
      expect(deps.cargar).toHaveBeenCalledTimes(1);
      expect(modal.open).toBe(true);
    } finally {
      ctx.mockRestore();
    }
  });

  it("thumb huérfana se revoca si el slot muere en la ventana", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    const revocar = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { generarMiniatura } = await import("../pipeline/queue");
    try {
      const { deps } = depsRecorte();
      const c = sembrar();
      const thumbVieja = c.thumbUrl;
      vi.mocked(generarMiniatura).mockImplementationOnce(async () => {
        state.hojas.length = 0; // Limpiar durante el await.
        return "blob:thumb";
      });
      await abrirRecorte(c.id, deps as never);
      btnOk.click();
      await vaciar();
      expect(revocar).toHaveBeenCalledWith("blob:thumb");
      expect(c.thumbUrl).toBe(thumbVieja);
    } finally {
      ctx.mockRestore();
      revocar.mockRestore();
    }
  });

  it("descarte en vuelo: cerrar durante toBlob no commitea", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { promise, resolve } = Promise.withResolvers<Blob | null>();
      const { deps, bmp } = depsRecorte();
      deps.crear = vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb: (b: Blob | null) => void) => void promise.then(cb),
      }));
      const c = sembrar();
      const antes = c.file;
      const urlVieja = c.imgUrl;
      await abrirRecorte(c.id, deps as never);
      btnOk.click();
      await vaciar(); // confirmar quedó esperando el toBlob
      modal.close(); // cancelar en vuelo
      resolve(new Blob(["recorte"]));
      await vaciar();
      // Sin el guard idAbierto, el commit sobrevivía al descarte.
      expect(c.file).toBe(antes);
      expect(c.imgUrl).toBe(urlVieja);
      expect(c.textoOcr).toBe("VIEJO");
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(bmp.close).toHaveBeenCalled();
    } finally {
      ctx.mockRestore();
    }
  });

  it("Tab no atrapa foco; ] rota el tirador activo", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      // Tab sin preventDefault: el orden nativo del <dialog> alcanza la barra.
      const tabLibre = guia.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
      expect(tabLibre).toBe(true);
      // activo pasa de "se" a "n": Shift+ArrowDown encoge desde el norte.
      guia.dispatchEvent(
        new KeyboardEvent("keydown", { key: "]", bubbles: true, cancelable: true }),
      );
      guia.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      btnOk.click();
      await vaciar();
      // Con el tirador viejo ("se"), bajar queda fijado al filo: altura 80.
      expect(creados[0]).toMatchObject({ width: 200 });
      expect(creados[0]?.height).toBeLessThan(80);
    } finally {
      ctx.mockRestore();
    }
  });

  it("limpiado durante el decode no abre editor fantasma", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { promise, resolve } = Promise.withResolvers<void>();
      const bmp = { width: 100, height: 80, close: vi.fn() };
      const deps = {
        cargar: vi.fn(async () => {
          await promise;
          return bmp;
        }),
        crear: vi.fn(),
      };
      const c = sembrar();
      const apertura = abrirRecorte(c.id, deps as never);
      state.hojas.length = 0; // Limpiar durante el decode.
      resolve();
      await apertura;
      expect(modal.open).toBe(false);
      expect(bmp.close).toHaveBeenCalled();
    } finally {
      ctx.mockRestore();
    }
  });

  it("arrastrar el interior a rect completo no cambia nada", async () => {
    const ctx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxFalso() as unknown as CanvasRenderingContext2D);
    try {
      const { deps, creados } = depsRecorte(200, 80);
      const c = sembrar();
      await abrirRecorte(c.id, deps as never);
      guia.dispatchEvent(puntero("pointerdown", 106, 46));
      guia.dispatchEvent(puntero("pointermove", 150, 60));
      guia.dispatchEvent(puntero("pointerup", 150, 60));
      btnOk.click();
      await vaciar();
      expect(creados[0]).toMatchObject({ width: 200, height: 80 });
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
