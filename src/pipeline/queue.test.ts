/* Tests P1: cola — drena pendientes aunque se limpie durante el proceso. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture } from "../test/fixture";

// Fase 1: contar renders (el mock no pinta; los tests asertan estado, no DOM).
vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));
// El auto IA real haría fetch: stub (cada test lo ajusta).
vi.mock("./extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));
// OCR real necesita onnx: quieto + texto vacío por defecto (como el fallo en
// jsdom); cada test simula giro/texto/girarBlob.
vi.mock("./ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ocr")>();
  return {
    ...real,
    enderezar: vi.fn(async (blob: Blob) => ({ blob, grados: 0, cajas: [], base: null })),
    extraerTexto: vi.fn(async () => ""),
    girarBlob: vi.fn(async () => null),
  };
});
// DocAligner real necesita onnx: identidad por defecto (no-op); cada test simula el corte.
vi.mock("./docaligner", async (importOriginal) => {
  const real = await importOriginal<typeof import("./docaligner")>();
  return { ...real, detectarYRecortar: vi.fn(async (b: Blob) => b) };
});

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

  it("throw en el render no aborta la cola (el ítem sigue a ok)", async () => {
    const h = crearHoja();
    const c = comprobante({ nombre: "t.png", file: new Blob(["x"]) });
    h.slots[0] = c;
    state.hojas.push(h);
    vi.mocked(renderHojas).mockImplementationOnce(() => {
      throw new Error("pintura");
    });
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.estado).toBe("ok");
    expect(state.colaEnProceso).toBe(false);
  });

  it("throw a mitad de drenaje: el ítem falla en error, los hermanos siguen", async () => {
    const h1 = crearHoja();
    const malo = comprobante({ nombre: "malo.png", file: new Blob(["x"]) });
    h1.slots[0] = malo;
    const h2 = crearHoja();
    const bueno = comprobante({ nombre: "bueno.png", file: new Blob(["y"]) });
    h2.slots[0] = bueno;
    state.hojas.push(h1, h2);
    // Inyección del fallo fuera de las etapas con catch: el log final lanza una vez.
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.mocked(console.info).mockImplementationOnce(() => {
      throw new Error("log");
    });
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(malo.estado).toBe("error");
    expect(bueno.estado).toBe("ok");
    expect(state.colaEnProceso).toBe(false);
  });

  it("enderezar con giro rota el previo junto al file", async () => {
    const { enderezar, girarBlob } = await import("./ocr");
    const h = crearHoja();
    const c = comprobante({
      nombre: "t.png",
      file: new Blob(["intake"]),
      previoDocAligner: new Blob(["previo"]),
    });
    h.slots[0] = c;
    state.hojas.push(h);
    const rotado = new Blob(["rotado"]);
    const previoRotado = new Blob(["previo-rotado"]);
    vi.mocked(enderezar).mockResolvedValueOnce({ blob: rotado, grados: 90, cajas: [], base: null });
    vi.mocked(girarBlob).mockResolvedValueOnce(previoRotado);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.file).toBe(rotado);
    expect(c.previoDocAligner).toBe(previoRotado);
    expect(c.estado).toBe("ok");
  });

  it("DocAligner que corta guarda el intake como previo", async () => {
    const { detectarYRecortar } = await import("./docaligner");
    const h = crearHoja();
    const intake = new Blob(["intake"]);
    const c = comprobante({ nombre: "t.png", file: intake });
    h.slots[0] = c;
    state.hojas.push(h);
    const cortado = new Blob(["doc"]);
    vi.mocked(detectarYRecortar).mockResolvedValueOnce(cortado);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.file).toBe(cortado);
    expect(c.previoDocAligner).toBe(intake);
  });

  it("DocAligner no-op no guarda previo", async () => {
    const h = crearHoja();
    const intake = new Blob(["intake"]);
    const c = comprobante({ nombre: "t.png", file: intake });
    h.slots[0] = c;
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.file).toBe(intake);
    expect(c.previoDocAligner).toBeUndefined();
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
