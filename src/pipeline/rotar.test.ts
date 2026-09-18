/* Tests P1: rotar.ts — giro manual ±90° + OCR único, sin enderezar. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture } from "../test/fixture";

// El render real necesita grilla; los tests asertan estado, no DOM.
vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));
// Sin onnx en jsdom: el giro real + texto stub (lienzoGirado sigue real).
vi.mock("./ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ocr")>();
  return { ...real, extraerTexto: vi.fn(async () => "TOTAL LEÍDO") };
});
// El lote post-giro no debe pegar a la red en tests.
vi.mock("./extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));
// Thumb controlable por test (asignarMiniatura sigue real).
vi.mock("./queue", async (importOriginal) => {
  const real = await importOriginal<typeof import("./queue")>();
  return { ...real, generarMiniatura: vi.fn(async () => "blob:thumb") };
});

montarFixture();
const { buscarSlot, crearHoja, state } = await import("../state");
const { girarYReleer, releerTrasEdicion } = await import("./rotar");
const { extraerTexto } = await import("./ocr");
const { extraerPendientes } = await import("./extract");
const { comprobante } = await import("../test/factoria");
const { generarMiniatura } = await import("./queue");
const { renderHojas } = await import("../ui/sheets");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(extraerPendientes).mockClear();
  vi.mocked(extraerTexto).mockClear();
  vi.mocked(generarMiniatura).mockClear();
  vi.mocked(renderHojas).mockClear();
  vi.useRealTimers();
});

/** Bitmap + lienzo falsos (suficiente para el lienzoGirado real). */
function depsGiro() {
  const creados: { width: number; height: number }[] = [];
  const bmp = { width: 10, height: 20, close: vi.fn() };
  return {
    creados,
    deps: {
      cargar: vi.fn(async () => bmp as unknown as ImageBitmap),
      crear: vi.fn(() => {
        const lienzo = {
          width: 0,
          height: 0,
          getContext: () => ({ setTransform: () => {}, drawImage: () => {} }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
        };
        creados.push(lienzo);
        return lienzo as unknown as HTMLCanvasElement;
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

describe("girarYReleer", () => {
  it("no-op sin item o sin estado ok", async () => {
    await expect(girarYReleer(999999, 90)).resolves.toBeUndefined();
    const c = sembrar();
    c.estado = "pendiente";
    await girarYReleer(c.id, 90);
    expect(c.estado).toBe("pendiente");
    expect(c.textoOcr).toBe("VIEJO");
  });

  it("90° gira al instante y relee una vez tras la quietud", async () => {
    vi.useFakeTimers();
    const { creados, deps } = depsGiro();
    const c = sembrar();
    const antes = c.file;
    await girarYReleer(c.id, 90, deps);
    expect(c.estado).toBe("ok");
    expect(c.file).not.toBe(antes);
    expect(c.file).toBeInstanceOf(Blob);
    // 10x20 girado 90° → lienzo 20x10.
    expect(creados[0]).toMatchObject({ width: 20, height: 10 });
    // Quietud: el OCR aún no corrió.
    expect(c.textoOcr).toBe("VIEJO");
    expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.textoOcr).toBe("TOTAL LEÍDO");
    expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(1);
    expect(c.montoCents).toBeNull(); // el lote lo relee (mock: queda manual)
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledTimes(1);
    // giro + procesando + ok + reapertura (el null se pinta aunque el lote sea no-op)
    expect(vi.mocked(renderHojas)).toHaveBeenCalledTimes(4);
  });

  it("el giro rota el previo junto al file (sigue ensanchable)", async () => {
    const { creados, deps } = depsGiro();
    const c = sembrar();
    const previoViejo = new Blob(["previo"]);
    c.previoDocAligner = previoViejo;
    await girarYReleer(c.id, 90, deps);
    expect(c.previoDocAligner).toBeInstanceOf(Blob);
    expect(c.previoDocAligner).not.toBe(previoViejo);
    // Giro principal + previo: ambos lienzos 10x20 → 20x10.
    expect(creados[1]).toMatchObject({ width: 20, height: 10 });
    expect(c.file).toBeInstanceOf(Blob);
  });

  it("relecturas concurrentes del mismo id se serializan (B espera a A)", async () => {
    const eventos: string[] = [];
    vi.mocked(extraerTexto).mockImplementation(async (b: Blob) => {
      const tag = b === blobA ? "A" : "B";
      eventos.push(`${tag}-ini`);
      await new Promise((r) => setTimeout(r, 10));
      eventos.push(`${tag}-fin`);
      return "LEÍDO";
    });
    const c = sembrar();
    const blobA = new Blob(["a"]);
    const blobB = new Blob(["b"]);
    try {
      await Promise.all([releerTrasEdicion(c.id, blobA), releerTrasEdicion(c.id, blobB)]);
      expect(eventos).toEqual(["A-ini", "A-fin", "B-ini", "B-fin"]);
      expect(c.textoOcr).toBe("LEÍDO");
    } finally {
      vi.mocked(extraerTexto).mockResolvedValue("TOTAL LEÍDO");
    }
  });

  it("con cola activa espera el drenaje antes del OCR y del lote", async () => {
    vi.useFakeTimers();
    const c = sembrar();
    state.colaEnProceso = true;
    try {
      const p = releerTrasEdicion(c.id, new Blob(["x"]));
      await vi.advanceTimersByTimeAsync(1000);
      // Sin solape de run(): ni OCR ni lote mientras la cola trabaja.
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(vi.mocked(extraerPendientes)).not.toHaveBeenCalled();
      state.colaEnProceso = false;
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(extraerPendientes)).toHaveBeenCalledTimes(1);
      expect(c.estado).toBe("ok");
    } finally {
      state.colaEnProceso = false;
      vi.useRealTimers();
    }
  });

  it("OCR fallido en la relectura: ok sin texto rancio, con aviso", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    await girarYReleer(c.id, 90, deps);
    vi.mocked(extraerTexto).mockRejectedValueOnce(new Error("ocr caído"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.estado).toBe("ok"); // no queda atascada en procesando
    expect(c.textoOcr).toBe(""); // el viejo es de otra orientación: no vale
    expect(c.montoCents).toBeNull();
    expect(document.getElementById("aviso")?.textContent).toBe(
      "No se pudo releer el texto girado.",
    );
  });

  it("sin thumb muestra el giro nuevo (sin esqueleto permanente)", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    vi.mocked(generarMiniatura).mockResolvedValueOnce(null);
    const h = crearHoja();
    const c = comprobante({ estado: "ok", file: new Blob(["foto"]) });
    c.thumbUrl = null; // imagen sin thumb (falló en la cola)
    h.slots[0] = c;
    state.hojas.push(h);
    await girarYReleer(c.id, 90, deps);
    expect(c.thumbUrl).toBe(c.imgUrl);
  });

  it("doble giro rápido: 2 giros al instante + 1 solo OCR", async () => {
    vi.useFakeTimers();
    const { creados, deps } = depsGiro();
    const c = sembrar();
    const p1 = girarYReleer(c.id, 90, deps);
    const p2 = girarYReleer(c.id, 90, deps);
    await Promise.all([p1, p2]);
    expect(creados).toHaveLength(2); // ambos giros aplicados en cadena
    expect(c.textoOcr).toBe("VIEJO");
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.textoOcr).toBe("TOTAL LEÍDO");
    expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledTimes(1);
  });

  it("giros separados por la quietud: un OCR por giro", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    await girarYReleer(c.id, 90, deps);
    await vi.advanceTimersByTimeAsync(1500);
    await girarYReleer(c.id, 270, deps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(extraerTexto)).toHaveBeenCalledTimes(2);
  });

  it("limpiar durante la espera: al disparar no escribe ni relee", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    await girarYReleer(c.id, 90, deps);
    state.hojas = [crearHoja()];
    await vi.advanceTimersByTimeAsync(5000);
    expect(buscarSlot(c.id)).toBeNull();
    expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
  });

  it("regresión: el lote post-giro incluye la propia celda (no se autoexcluye)", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    const { candidatos } = await vi.importActual<typeof import("./extract")>("./extract");
    // Lote simulado con la lógica real de inclusión: si la celda es candidata, la rellena.
    vi.mocked(extraerPendientes).mockImplementationOnce(async () => {
      if (candidatos().some((x) => x.id === c.id)) c.montoCents = 999;
    });
    await girarYReleer(c.id, 90, deps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.montoCents).toBe(999); // antes: quedaba en null (procesando la excluía)
  });

  it("celda manual: conserva el total y no llama al lote", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    c.montoManual = true;
    await girarYReleer(c.id, 270, deps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.estado).toBe("ok");
    expect(c.textoOcr).toBe("TOTAL LEÍDO");
    expect(c.montoCents).toBe(123);
    expect(vi.mocked(extraerPendientes)).not.toHaveBeenCalled();
  });

  it("fallo de decode: restaura ok con la imagen anterior y avisa", async () => {
    const c = sembrar();
    const antes = c.file;
    await girarYReleer(c.id, 270, {
      cargar: async () => {
        throw new Error("roto");
      },
    });
    expect(c.estado).toBe("ok");
    expect(c.file).toBe(antes);
    expect(c.textoOcr).toBe("VIEJO");
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo girar la imagen.");
  });

  it("limpiado a mitad del giro: no escribe ni resucita", async () => {
    let soltar: ((b: ImageBitmap) => void) | undefined;
    const bmp = { width: 10, height: 20, close: vi.fn() };
    const c = sembrar();
    const p = girarYReleer(c.id, 90, {
      cargar: () =>
        new Promise<ImageBitmap>((res) => {
          soltar = res;
        }),
    });
    for (let i = 0; i < 100 && !soltar; i++) await Promise.resolve();
    soltar?.(bmp as unknown as ImageBitmap);
    const urlAntes = c.imgUrl;
    state.hojas = [crearHoja()]; // Limpiar reemplaza el array a mitad del giro
    await p;
    expect(buscarSlot(c.id)).toBeNull();
    expect(c.imgUrl).toBe(urlAntes); // el giro huérfano se descarta
  });

  it("thumb huérfana se revoca si el slot muere en la ventana", async () => {
    const revocar = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const { deps } = depsGiro();
      const c = sembrar();
      const thumbVieja = c.thumbUrl;
      vi.mocked(generarMiniatura).mockImplementationOnce(async () => {
        state.hojas = [crearHoja()]; // Limpiar durante el await.
        return "blob:thumb";
      });
      await girarYReleer(c.id, 90, deps);
      expect(revocar).toHaveBeenCalledWith("blob:thumb");
      expect(c.thumbUrl).toBe(thumbVieja);
    } finally {
      revocar.mockRestore();
    }
  });

  it("previo que no gira aborta el giro (sin mezcla de orientaciones)", async () => {
    const { deps } = depsGiro();
    const c = sembrar();
    const previoViejo = new Blob(["previo"]);
    c.previoDocAligner = previoViejo;
    const antes = c.file;
    const urlVieja = c.imgUrl;
    // Solo el segundo lienzo (el del previo) falla: toBlob null.
    const crearBase = deps.crear.getMockImplementation();
    let llamadas = 0;
    deps.crear.mockImplementation(() => {
      llamadas++;
      const lienzo = (crearBase?.() ?? {}) as {
        toBlob: (cb: (b: Blob | null) => void) => void;
      } & Record<string, unknown>;
      if (llamadas === 2) lienzo.toBlob = (cb) => cb(null);
      return lienzo as unknown as HTMLCanvasElement;
    });
    await girarYReleer(c.id, 90, deps);
    // Sin el throw, el giro commiteaba file rotado con previo viejo.
    expect(c.file).toBe(antes);
    expect(c.imgUrl).toBe(urlVieja);
    expect(c.previoDocAligner).toBe(previoViejo);
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo girar la imagen.");
  });

  it("sin thumb se revoca la thumb vieja distinta (sin fuga)", async () => {
    const revocar = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const { deps } = depsGiro();
      vi.mocked(generarMiniatura).mockResolvedValueOnce(null);
      const c = sembrar();
      c.thumbUrl = "blob:thumb-vieja";
      await girarYReleer(c.id, 90, deps);
      expect(revocar).toHaveBeenCalledWith("blob:thumb-vieja");
      expect(c.thumbUrl).toBe(c.imgUrl);
    } finally {
      revocar.mockRestore();
    }
  });

  it("timer rancio no relee si otro editor commitió después", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = depsGiro();
      const c = sembrar();
      await girarYReleer(c.id, 90, deps); // programa el timer diferido
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      c.file = new Blob(["otro"]); // un recorte commitió después del giro
      await vi.advanceTimersByTimeAsync(2000);
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(c.textoOcr).toBe("VIEJO");
    } finally {
      vi.useRealTimers();
    }
  });

  it("giro y recorte en vuelo: el último commit gana entero, sin mezcla", async () => {
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const crearUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((b: unknown) => `blob:${(b as Blob).size}`);
    const { abrirRecorte, initRecorte } = await import("../ui/recorte");
    const { cancelarRelecturaProgramada } = await import("./rotar");
    initRecorte();
    try {
      const bmpGiro = { width: 10, height: 20, close: vi.fn() };
      const previoBlob = new Blob(["previo"]);
      let soltarGiro: ((b: ImageBitmap) => void) | undefined;
      let soltarPrevio: ((b: ImageBitmap) => void) | undefined;
      const depsGiro = {
        // Puertas por fuente: el giro se suspende en el previo, a mitad del commit.
        cargar: (f: Blob) => {
          if (f === previoBlob) {
            return new Promise<ImageBitmap>((res) => {
              soltarPrevio = res;
            });
          }
          return new Promise<ImageBitmap>((res) => {
            soltarGiro = res;
          });
        },
        crear: vi.fn(() => ({
          width: 0,
          height: 0,
          getContext: () => ({ setTransform: vi.fn(), drawImage: vi.fn() }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
        })),
      };
      const bmpCrop = { width: 100, height: 80, close: vi.fn() };
      const depsCrop = {
        cargar: vi.fn(async () => bmpCrop),
        crear: vi.fn(() => ({
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }),
          toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["recorte"])),
        })),
      };
      vi.mocked(generarMiniatura)
        .mockImplementationOnce(async (f: Blob) => `thumb:${f.size}`)
        .mockImplementationOnce(async (f: Blob) => `thumb:${f.size}`);
      const c = sembrar();
      c.previoDocAligner = previoBlob;
      const pg = girarYReleer(c.id, 90, depsGiro as never);
      await abrirRecorte(c.id, depsCrop as never);
      for (let i = 0; i < 100 && !soltarGiro; i++) await Promise.resolve();
      soltarGiro?.(bmpGiro as unknown as ImageBitmap);
      // El giro queda suspendido entre imgUrl= y file= (código viejo): ahí
      // commitea el recorte entero y recién después termina el giro.
      for (let i = 0; i < 200 && !soltarPrevio; i++) await Promise.resolve();
      document.getElementById("btnRecorteOk")?.click();
      await new Promise((r) => setTimeout(r, 200)); // confirmar entero (C gana píxeles)
      expect(await (c.file as Blob).text()).toBe("recorte");
      soltarPrevio?.(bmpGiro as unknown as ImageBitmap);
      await pg;
      await new Promise((r) => setTimeout(r, 100));
      cancelarRelecturaProgramada(c.id); // el timer del giro no fuga al resto
      // El giro terminó último: todo G ("girado" 6B), nada de C ("recorte" 7B).
      expect(await (c.file as Blob).text()).toBe("girado");
      expect(c.imgUrl).toBe("blob:6");
      expect(c.thumbUrl).toBe("thumb:6");
      const modal = document.getElementById("modalRecorte") as HTMLDialogElement | null;
      if (modal?.open) modal.close();
    } finally {
      ctx.mockRestore();
      crearUrl.mockRestore();
    }
  });
});
