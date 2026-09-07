/* Tests P1: cola — drena pendientes aunque se limpie durante el proceso. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture } from "../test/fixture";

// Fase 1: contar renders (el mock no pinta; los tests asertan estado, no DOM).
vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));
// El auto IA real haría fetch: stub (cada test lo ajusta).
vi.mock("./extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));

montarFixture();
const { buscarSlot, crearHoja, state } = await import("../state");
const { asignarMiniatura, procesarCola } = await import("./queue");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("../ui/sheets");
const { extraerPendientes } = await import("./extract");

beforeEach(() => {
  // Sin file ni imgUrl real el recorte falla al blob y sigue con el original: se avanza igual.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("procesarCola", () => {
  it("limpiar durante el proceso no deja huérfano al archivo nuevo", async () => {
    const h = crearHoja();
    const viejo = comprobante({ nombre: "viejo.png" });
    h.slots[0] = viejo;
    state.hojas.push(h);
    const p = procesarCola();
    expect(viejo.estado).toBe("procesando");
    // Limpiar reemplaza el array (cierra modalLimpiar con 'ok').
    const nh = crearHoja();
    const nuevo = comprobante({ nombre: "nuevo.png" });
    nh.slots[0] = nuevo;
    state.hojas = [nh];
    await vi.advanceTimersByTimeAsync(1000); // termina el sleep del viejo (descartado)
    await vi.advanceTimersByTimeAsync(1000); // procesa el nuevo
    await p;
    expect(buscarSlot(viejo.id)).toBeNull();
    expect(nuevo.estado).toBe("ok");
    // Sin Chrome el OCR real falla y deja texto vacío + monto manual (null).
    expect(nuevo.textoOcr).toBe("");
    expect(nuevo.montoCents).toBeNull();
    expect(state.colaEnProceso).toBe(false);
  });

  it("informa tiempos por etapa (L0: recorte/minis/enderezar/extraer/total)", async () => {
    const h = crearHoja();
    const c = comprobante({ nombre: "t.png" });
    h.slots[0] = c;
    state.hojas.push(h);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    const linea = info.mock.calls.map((a) => String(a[0])).find((s) => s.startsWith("OCR ms"));
    expect(linea).toMatch(/recorte=\d+ minis=\d+ enderezar=\d+ extraer=\d+/);
    expect(linea).toMatch(/cajas=\d+ batch=\[\d+,\d+\] fallback=(sí|no) recRuns=\d+ total=\d+/);
  });

  it("lote de 3: 3 renders de estado + 1 final (coalescado, Fase 1)", async () => {
    for (const n of ["a.png", "b.png", "c.png"]) {
      const h = crearHoja();
      h.slots[0] = comprobante({ nombre: n });
      state.hojas.push(h);
    }
    const antes = vi.mocked(renderHojas).mock.calls.length;
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    // Sin coalescar serían 6 (2 por ítem); con coalescado 3+1.
    expect(vi.mocked(renderHojas).mock.calls.length - antes).toBe(4);
  });

  it("al drenar dispara el auto IA con desdeCola", async () => {
    vi.mocked(extraerPendientes).mockClear();
    const h = crearHoja();
    h.slots[0] = comprobante({ nombre: "t.png" });
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledWith({ desdeCola: true });
  });

  it("pendiente entrado durante la IA también se drena (no huérfano)", async () => {
    let unaVez = false;
    vi.mocked(extraerPendientes).mockImplementation(async () => {
      if (unaVez) return;
      unaVez = true;
      const h = crearHoja();
      h.slots[0] = comprobante({ nombre: "tardio.png" });
      state.hojas.push(h);
    });
    try {
      const h = crearHoja();
      h.slots[0] = comprobante({ nombre: "t.png" });
      state.hojas.push(h);
      const p = procesarCola();
      await vi.advanceTimersByTimeAsync(6000);
      await p;
      const tardio = state.hojas.flatMap((hh) => hh.slots).find((c) => c?.nombre === "tardio.png");
      expect(tardio?.estado).toBe("ok");
    } finally {
      vi.mocked(extraerPendientes).mockResolvedValue(undefined);
    }
  });

  it("asignarMiniatura no revoca el imgUrl aliased (PDF, hilo #1 PR9)", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const pdf = comprobante({ imgUrl: "blob:x", thumbUrl: "blob:x" });
    asignarMiniatura(pdf, "blob:thumb-nueva");
    expect(revoke).not.toHaveBeenCalled(); // sin el fix revocaba "blob:x"
    expect(pdf.thumbUrl).toBe("blob:thumb-nueva");
    expect(pdf.imgUrl).toBe("blob:x");
  });

  it("asignarMiniatura revoca el thumb viejo distinto", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const img = comprobante({ imgUrl: "blob:img", thumbUrl: "blob:vieja" });
    asignarMiniatura(img, "blob:thumb-nueva");
    expect(revoke).toHaveBeenCalledWith("blob:vieja");
    expect(img.thumbUrl).toBe("blob:thumb-nueva");
  });
});
