/* Tests P1: cola — drena pendientes aunque se limpie durante el proceso. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture } from "../test/fixture";

montarFixture();
const { buscarSlot, crearHoja, state } = await import("../state");
const { procesarCola } = await import("./queue");
const { comprobante } = await import("../test/factoria");

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
});
