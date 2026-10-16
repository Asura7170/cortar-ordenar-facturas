/* Tests P1: cola — drena pendientes aunque se limpie durante el proceso. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture } from "../test/fixture";
import type { SesionDetectora } from "./docaligner";
import type { NucleoOcr } from "./ocr";

// Fase 1: contar renders (el mock no pinta; los tests asertan estado, no DOM).
vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));
// El re-chequeo del drenado sale de este módulo: stub (cada test lo ajusta);
// aplicarTotales se envuelve con vi.fn(implementación real): la rama rápida
// la usa y los tests pueden envenenar una llamada (fail-path del drenaje).
vi.mock("./extract", async (importOriginal) => {
  const real = await importOriginal<typeof import("./extract")>();
  return {
    ...real,
    extraerPendientes: vi.fn((): void => {}),
    aplicarTotales: vi.fn(real.aplicarTotales),
  };
});
// OCR real necesita onnx: quieto + texto vacío por defecto (como el fallo en
// jsdom); cada test simula giro/texto/girarBlob. El warmup usa sesiones falsas.
vi.mock("./ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ocr")>();
  const nucleoFalso = {} as unknown as NucleoOcr;
  return {
    ...real,
    enderezar: vi.fn(async (blob: Blob) => ({ blob, grados: 0, cajas: [], base: null })),
    extraerTexto: vi.fn(async () => ""),
    girarBlob: vi.fn(async () => null),
    obtenerNucleo: vi.fn(async () => nucleoFalso),
  };
});
// DocAligner real necesita onnx: identidad por defecto (no-op); cada test simula el corte.
// La sesión es falsa para que el warmup avance sin GPU.
vi.mock("./docaligner", async (importOriginal) => {
  const real = await importOriginal<typeof import("./docaligner")>();
  const sesionFalsa: SesionDetectora = {
    inferir: async () => ({ datos: new Float32Array(0), dims: [] }),
  };
  return {
    ...real,
    detectarYRecortar: vi.fn(async (b: Blob) => b),
    obtenerSesion: vi.fn(async () => sesionFalsa),
  };
});

montarFixture();
const { buscarSlot, crearHoja, state } = await import("../state");
const { procesarCola } = await import("./queue");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("../ui/sheets");
const { extraerPendientes } = await import("./extract");
const { extraerTexto } = await import("./ocr");

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

  it("rápido fija el monto por aplicarTotales (1 distinto, sin red)", async () => {
    state.hojas = [];
    vi.mocked(extraerTexto).mockResolvedValueOnce("TOTAL 12.50");
    const h = crearHoja();
    const c = comprobante({ nombre: "rapida.png", file: new Blob(["foto"]) });
    h.slots[0] = c;
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.textoOcr).toBe("TOTAL 12.50");
    expect(c.montoCents).toBe(1250);
  });

  it("lote de 3: 3 procesando + 3 ok inmediato + 1 final (imagen primero)", async () => {
    for (const n of ["a.png", "b.png", "c.png"]) {
      const h = crearHoja();
      h.slots[0] = comprobante({ nombre: n });
      state.hojas.push(h);
    }
    const antes = vi.mocked(renderHojas).mock.calls.length;
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    // 2 por ítem (procesando + ok con imagen) + 1 final del drenado.
    expect(vi.mocked(renderHojas).mock.calls.length - antes).toBe(7);
  });

  it("al drenar dispara el re-chequeo con desdeCola", async () => {
    vi.mocked(extraerPendientes).mockClear();
    const h = crearHoja();
    h.slots[0] = comprobante({ nombre: "t.png" });
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledWith({ desdeCola: true });
  });

  it("pendiente entrado durante el drenado también se procesa (no huérfano)", async () => {
    // La ventana real de entrada tardía son los await de OCR/render (mockeados
    // aquí): el re-escaneo del for levanta lo aterrizado a mitad de cola.
    let entrada = false;
    vi.mocked(renderHojas).mockImplementation((): void => {
      if (entrada) return;
      entrada = true;
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
      vi.mocked(renderHojas).mockImplementation(() => {});
    }
  });

  it("throw en el re-chequeo no tumba la cola (los pendientes siguen ok)", async () => {
    vi.mocked(extraerPendientes).mockImplementationOnce((): void => {
      throw new Error("re-chequeo explotó");
    });
    const h = crearHoja();
    const c = comprobante({ nombre: "t.png", file: new Blob(["x"]) });
    h.slots[0] = c;
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.estado).toBe("ok");
    expect(state.colaEnProceso).toBe(false);
  });

  it("throw a mitad del drenaje: el ítem falla en error y los hermanos siguen", async () => {
    const { aplicarTotales } = await import("./extract");
    vi.mocked(aplicarTotales).mockImplementationOnce((): number => {
      throw new Error("veneno"); // explota el fast-path dentro de completarItem
    });
    vi.mocked(extraerTexto).mockResolvedValueOnce("TOTAL 12.50"); // fuerza el fast-path del 1º
    const h = crearHoja();
    const malo = comprobante({ nombre: "malo.png", file: new Blob(["x"]) });
    h.slots[0] = malo;
    const h2 = crearHoja();
    const bueno = comprobante({ nombre: "bueno.png" });
    h2.slots[0] = bueno;
    state.hojas.push(h, h2);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(malo.estado).toBe("error"); // el catch del drenado lo cierra, no "procesando" eterno
    expect(bueno.estado).toBe("ok"); // los hermanos siguen después del veneno
    expect(state.colaEnProceso).toBe(false);
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

  it("fallo del OCR deja texto vacío sin abortar el ítem", async () => {
    const { extraerTexto } = await import("./ocr");
    vi.mocked(extraerTexto).mockRejectedValueOnce(new Error("ocr caído"));
    const h = crearHoja();
    const c = comprobante({ nombre: "t.png", file: new Blob(["foto"]) });
    h.slots[0] = c;
    state.hojas.push(h);
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.textoOcr).toBe("");
    expect(c.estado).toBe("ok");
  });

  it("enderezar que rechaza deja el blob sin girar y sigue a ok (catch de la fase)", async () => {
    const { enderezar, extraerTexto } = await import("./ocr");
    const h = crearHoja();
    const intake = new Blob(["intake"]);
    const c = comprobante({ nombre: "t.png", file: intake });
    h.slots[0] = c;
    state.hojas.push(h);
    vi.mocked(enderezar).mockRejectedValueOnce(new Error("giro roto"));
    vi.mocked(extraerTexto).mockResolvedValueOnce("TOTAL 30");
    const p = procesarCola();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(c.file).toBe(intake); // el giro no se commiteó
    expect(c.textoOcr).toBe("TOTAL 30"); // el OCR corrió sobre el blob sin girar (reuse undefined)
    expect(c.estado).toBe("ok");
  });

  it("PDF sin file recupera el blob por fetch", async () => {
    const bytes = new Blob(["pdf"]);
    const red = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ blob: async () => bytes } as Response);
    try {
      const h = crearHoja();
      const c = comprobante({ nombre: "d.pdf" });
      h.slots[0] = c;
      state.hojas.push(h);
      const p = procesarCola();
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(red).toHaveBeenCalled();
      expect(c.estado).toBe("ok");
    } finally {
      red.mockRestore();
    }
  });

  it("limpieza durante el recorte revoca la URL nueva sin resucitar", async () => {
    const { detectarYRecortar } = await import("./docaligner");
    const h = crearHoja();
    const c = comprobante({ nombre: "t.png", file: new Blob(["foto"]) });
    h.slots[0] = c;
    state.hojas.push(h);
    const cortado = new Blob(["doc"]);
    vi.mocked(detectarYRecortar).mockImplementationOnce(async () => {
      state.hojas = [];
      return cortado;
    });
    const revocar = vi.spyOn(URL, "revokeObjectURL");
    try {
      const p = procesarCola();
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(buscarSlot(c.id)).toBeNull();
      expect(revocar).toHaveBeenCalled();
    } finally {
      revocar.mockRestore();
    }
  });

  it("limpieza durante el giro del previo revoca sin mutar", async () => {
    const { enderezar, girarBlob } = await import("./ocr");
    const h = crearHoja();
    const intake = new Blob(["intake"]);
    const c = comprobante({
      nombre: "t.png",
      file: intake,
      previoDocAligner: new Blob(["previo"]),
    });
    h.slots[0] = c;
    state.hojas.push(h);
    const rotado = new Blob(["rotado"]);
    vi.mocked(enderezar).mockResolvedValueOnce({ blob: rotado, grados: 90, cajas: [], base: null });
    vi.mocked(girarBlob).mockImplementationOnce(async () => {
      state.hojas = [];
      return new Blob(["previo-rotado"]);
    });
    const revocar = vi.spyOn(URL, "revokeObjectURL");
    const crear = vi.spyOn(URL, "createObjectURL");
    try {
      const p = procesarCola();
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(buscarSlot(c.id)).toBeNull();
      expect(c.file).toBe(intake);
      // La URL revocada es la rotada (la vieja ya se revocó antes del giro).
      const imgNueva = crear.mock.results[0]?.value as string;
      expect(revocar).toHaveBeenCalledWith(imgNueva);
    } finally {
      crear.mockRestore();
      revocar.mockRestore();
    }
  });
});

describe("precalentarModelos", () => {
  it("doble llamada: la segunda es no-op (fallback setTimeout)", async () => {
    const w = window as unknown as Record<string, unknown>;
    const previa = w["requestIdleCallback"];
    delete w["requestIdleCallback"];
    try {
      vi.resetModules();
      const q = await import("./queue");
      q.precalentarModelos();
      q.precalentarModelos();
      await vi.advanceTimersByTimeAsync(100);
      // El warmup avanzó hasta el núcleo (sesiones falsas, sin onnx).
      const { obtenerSesion } = await import("./docaligner");
      const { obtenerNucleo } = await import("./ocr");
      expect(vi.mocked(obtenerSesion)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(obtenerNucleo)).toHaveBeenCalledTimes(1);
    } finally {
      if (previa !== undefined) w["requestIdleCallback"] = previa;
    }
  });

  it("usa requestIdleCallback cuando existe", async () => {
    const w = window as unknown as Record<string, unknown>;
    const previa = w["requestIdleCallback"];
    const ocioso = vi.fn((cb: () => void): number => {
      cb();
      return 1;
    });
    w["requestIdleCallback"] = ocioso;
    try {
      vi.resetModules();
      const q = await import("./queue");
      q.precalentarModelos();
      await vi.advanceTimersByTimeAsync(100);
      const { obtenerSesion } = await import("./docaligner");
      const { obtenerNucleo } = await import("./ocr");
      expect(ocioso).toHaveBeenCalledTimes(1);
      expect(vi.mocked(obtenerSesion)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(obtenerNucleo)).toHaveBeenCalledTimes(1);
    } finally {
      if (previa === undefined) delete w["requestIdleCallback"];
      else w["requestIdleCallback"] = previa;
    }
  });
});
