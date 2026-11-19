/* Tests P1: rotar.ts — giro manual ±90° + OCR único, sin enderezar. */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { montarFixture } from "../test/fixture";
import type { CargarBitmap, CrearLienzo } from "./imagen";

// El render real necesita grilla; los tests asertan estado, no DOM.
vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn<() => void>() }));
// Sin onnx en jsdom: el giro real + texto stub (lienzoGirado sigue real).
vi.mock("./ocr", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ocr")>();
  return { ...real, extraerTexto: vi.fn<typeof real.extraerTexto>(async () => "TOTAL LEÍDO") };
});
// El re-chequeo post-giro va mockeado en tests (rotar lo llama tras releer OCR).
vi.mock("./extract", () => ({
  extraerPendientes: vi.fn<typeof import("./extract").extraerPendientes>((): void => {}),
}));

montarFixture();
const { buscarSlot, crearHoja, state } = await import("../state");
const { girarYReleer, releerTrasEdicion } = await import("./rotar");
const { extraerTexto } = await import("./ocr");
const { extraerPendientes } = await import("./extract");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("../ui/sheets");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(extraerPendientes).mockClear();
  vi.mocked(extraerTexto).mockClear();
  vi.mocked(renderHojas).mockClear();
  vi.useRealTimers();
});

/** Bitmap + lienzo falsos (suficiente para el lienzoGirado real). */
function depsGiro() {
  const creados: { width: number; height: number }[] = [];
  const bmp = { width: 10, height: 20, close: vi.fn<() => void>() };
  return {
    creados,
    deps: {
      cargar: vi.fn<CargarBitmap>(async () => bmp as unknown as ImageBitmap),
      crear: vi.fn<CrearLienzo>(() => {
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
    await expect(girarYReleer(999_999, 90)).resolves.toBeUndefined();
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
    expect(vi.mocked(extraerTexto)).toHaveBeenCalledOnce();
    // el lote lo relee (mock: queda manual)
    expect(c.montoCents).toBeNull();
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledOnce();
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
      expect(eventos).toStrictEqual(["A-ini", "A-fin", "B-ini", "B-fin"]);
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
      expect(vi.mocked(extraerTexto)).toHaveBeenCalledOnce();
      expect(vi.mocked(extraerPendientes)).toHaveBeenCalledOnce();
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
    // no queda atascada en procesando
    expect(c.estado).toBe("ok");
    // el viejo es de otra orientación: no vale
    expect(c.textoOcr).toBe("");
    expect(c.montoCents).toBeNull();
    expect(document.getElementById("aviso")?.textContent).toBe(
      "No se pudo releer el texto girado.",
    );
  });

  it("el giro commitea file e imgUrl nuevos al instante", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const h = crearHoja();
    const c = comprobante({ estado: "ok", file: new Blob(["foto"]) });
    const urlAntes = c.imgUrl;
    h.slots[0] = c;
    state.hojas.push(h);
    await girarYReleer(c.id, 90, deps);
    expect(c.file).toBeInstanceOf(Blob);
    expect(c.imgUrl).not.toBe(urlAntes);
  });

  it("doble giro rápido: 2 giros al instante + 1 solo OCR", async () => {
    vi.useFakeTimers();
    const { creados, deps } = depsGiro();
    const c = sembrar();
    const p1 = girarYReleer(c.id, 90, deps);
    const p2 = girarYReleer(c.id, 90, deps);
    await Promise.all([p1, p2]);
    // ambos giros aplicados en cadena
    expect(creados).toHaveLength(2);
    expect(c.textoOcr).toBe("VIEJO");
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.textoOcr).toBe("TOTAL LEÍDO");
    expect(vi.mocked(extraerTexto)).toHaveBeenCalledOnce();
    expect(vi.mocked(extraerPendientes)).toHaveBeenCalledOnce();
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
    vi.mocked(extraerPendientes).mockImplementationOnce((): void => {
      if (candidatos().some((x) => x.id === c.id)) {
        c.montoCents = 999;
      }
    });
    await girarYReleer(c.id, 90, deps);
    await vi.advanceTimersByTimeAsync(1500);
    // antes: quedaba en null (procesando la excluía)
    expect(c.montoCents).toBe(999);
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
    const bmp = { width: 10, height: 20, close: vi.fn<() => void>() };
    const c = sembrar();
    const p = girarYReleer(c.id, 90, {
      cargar: () =>
        new Promise<ImageBitmap>((res) => {
          soltar = res;
        }),
    });
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- soltar lo muta el executor; cota 100
    for (let i = 0; i < 100 && !soltar; i++) {
      await Promise.resolve();
    }
    soltar?.(bmp as unknown as ImageBitmap);
    const urlAntes = c.imgUrl;
    // Limpiar reemplaza el array a mitad del giro
    state.hojas = [crearHoja()];
    await p;
    expect(buscarSlot(c.id)).toBeNull();
    // el giro huérfano se descarta
    expect(c.imgUrl).toBe(urlAntes);
  });

  it("giro huérfano revoca el imgUrl nuevo (sin fuga)", async () => {
    const revocar = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const crearUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:nuevo");
    try {
      let soltar: ((b: ImageBitmap) => void) | undefined;
      const bmp = { width: 10, height: 20, close: vi.fn<() => void>() };
      const c = sembrar();
      const urlAntes = c.imgUrl;
      const p = girarYReleer(c.id, 90, {
        cargar: () =>
          new Promise<ImageBitmap>((res) => {
            soltar = res;
          }),
        crear: () =>
          ({
            width: 0,
            height: 0,
            getContext: () => ({ setTransform: () => {}, drawImage: () => {} }),
            toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
          }) as unknown as HTMLCanvasElement,
      });
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- soltar lo muta el executor; cota 100
      for (let i = 0; i < 100 && !soltar; i++) {
        await Promise.resolve();
      }
      soltar?.(bmp as unknown as ImageBitmap);
      // Limpiar durante el await.
      state.hojas = [crearHoja()];
      await p;
      expect(revocar).toHaveBeenCalledWith("blob:nuevo");
      expect(c.imgUrl).toBe(urlAntes);
    } finally {
      revocar.mockRestore();
      crearUrl.mockRestore();
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
      if (llamadas === 2) {
        lienzo.toBlob = (cb) => cb(null);
      }
      return lienzo as unknown as HTMLCanvasElement;
    });
    await girarYReleer(c.id, 90, deps);
    // Sin el throw, el giro commiteaba file rotado con previo viejo.
    expect(c.file).toBe(antes);
    expect(c.imgUrl).toBe(urlVieja);
    expect(c.previoDocAligner).toBe(previoViejo);
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo girar la imagen.");
  });

  it("timer rancio no relee si otro editor commitió después", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = depsGiro();
      const c = sembrar();
      // programa el timer diferido
      await girarYReleer(c.id, 90, deps);
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      // un recorte commitió después del giro
      c.file = new Blob(["otro"]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(c.textoOcr).toBe("VIEJO");
    } finally {
      vi.useRealTimers();
    }
  });

  it("giro y recorte en vuelo: el último commit gana entero, sin mezcla", async () => {
    const ctx = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn<CanvasRenderingContext2D["setTransform"]>(),
      clearRect: vi.fn<CanvasRenderingContext2D["clearRect"]>(),
      fillRect: vi.fn<CanvasRenderingContext2D["fillRect"]>(),
      strokeRect: vi.fn<CanvasRenderingContext2D["strokeRect"]>(),
      drawImage: vi.fn<CanvasRenderingContext2D["drawImage"]>(),
    } as unknown as CanvasRenderingContext2D);
    const crearUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((b: unknown) => `blob:${(b as Blob).size}`);
    const { abrirRecorte, initRecorte } = await import("../ui/recorte");
    const { cancelarRelecturaProgramada } = await import("./rotar");
    initRecorte();
    try {
      const bmpGiro = { width: 10, height: 20, close: vi.fn<() => void>() };
      const previoBlob = new Blob(["previo"]);
      let soltarGiro: ((b: ImageBitmap) => void) | undefined;
      let soltarPrevio: ((b: ImageBitmap) => void) | undefined;
      const depsGiroEnVuelo = {
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
        crear: vi.fn<CrearLienzo>(
          () =>
            ({
              width: 0,
              height: 0,
              getContext: () => ({
                setTransform: vi.fn<CanvasRenderingContext2D["setTransform"]>(),
                drawImage: vi.fn<CanvasRenderingContext2D["drawImage"]>(),
              }),
              toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
            }) as unknown as HTMLCanvasElement,
        ),
      };
      const bmpCrop = { width: 100, height: 80, close: vi.fn<() => void>() };
      const depsCrop = {
        cargar: vi.fn<CargarBitmap>(async () => bmpCrop as unknown as ImageBitmap),
        crear: vi.fn<CrearLienzo>(
          () =>
            ({
              width: 0,
              height: 0,
              getContext: () => ({ drawImage: vi.fn<CanvasRenderingContext2D["drawImage"]>() }),
              toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["recorte"])),
            }) as unknown as HTMLCanvasElement,
        ),
      };
      const c = sembrar();
      c.previoDocAligner = previoBlob;
      const pg = girarYReleer(c.id, 90, depsGiroEnVuelo as never);
      await abrirRecorte(c.id, depsCrop as never);
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- lo muta el executor; cota 100
      for (let i = 0; i < 100 && !soltarGiro; i++) {
        await Promise.resolve();
      }
      soltarGiro?.(bmpGiro as unknown as ImageBitmap);
      // El giro queda suspendido entre imgUrl= y file= (código viejo): ahí
      // commitea el recorte entero y recién después termina el giro.
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- lo muta el executor; cota 200
      for (let i = 0; i < 200 && !soltarPrevio; i++) {
        await Promise.resolve();
      }
      document.getElementById("btnRecorteOk")?.click();
      // confirmar entero (C gana píxeles)
      await new Promise((r) => setTimeout(r, 200));
      await expect((c.file as Blob).text()).resolves.toBe("recorte");
      soltarPrevio?.(bmpGiro as unknown as ImageBitmap);
      await pg;
      await new Promise((r) => setTimeout(r, 100));
      // el timer del giro no fuga al resto
      cancelarRelecturaProgramada(c.id);
      // El giro terminó último: todo G ("girado" 6B), nada de C ("recorte" 7B).
      await expect((c.file as Blob).text()).resolves.toBe("girado");
      expect(c.imgUrl).toBe("blob:6");
      const modal = document.getElementById("modalRecorte") as HTMLDialogElement | null;
      if (modal?.open) {
        modal.close();
      }
    } finally {
      ctx.mockRestore();
      crearUrl.mockRestore();
    }
  });
});

describe("ramas de cubrimiento (lote 10)", () => {
  it("giro sin file: recurre a fetch(imgUrl) y commitea igual", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const h = crearHoja();
    // sin file
    const c = comprobante({ estado: "ok", montoCents: 123, textoOcr: "VIEJO" });
    h.slots[0] = c;
    state.hojas.push(h);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      blob: async () => new Blob(["de red"]),
    } as unknown as Response);
    const urlOrigen = c.imgUrl;
    try {
      await girarYReleer(c.id, 90, deps);
      expect(fetchSpy).toHaveBeenCalledWith(urlOrigen);
      expect(c.file).toBeInstanceOf(Blob);
      await expect((c.file as Blob).text()).resolves.toBe("girado");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("contexto 2d ausente: aborta el giro con aviso y sin commit", async () => {
    const bmp = { width: 10, height: 20, close: vi.fn<() => void>() };
    const c = sembrar();
    const antes = c.file;
    await girarYReleer(c.id, 90, {
      cargar: vi.fn<CargarBitmap>(async () => bmp as unknown as ImageBitmap),
      crear: vi.fn<CrearLienzo>(
        () =>
          ({
            width: 0,
            height: 0,
            getContext: () => null,
            toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["girado"])),
          }) as unknown as HTMLCanvasElement,
      ),
    });
    expect(c.file).toBe(antes);
    // el giro abortó: ni file ni url nuevos
    expect(c.imgUrl).toBe("blob:mock-1");
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo girar la imagen.");
  });

  it("toBlob nulo en el giro principal: aborta con aviso sin commit", async () => {
    const bmp = { width: 10, height: 20, close: vi.fn<() => void>() };
    const c = sembrar();
    const antes = c.file;
    await girarYReleer(c.id, 90, {
      cargar: vi.fn<CargarBitmap>(async () => bmp as unknown as ImageBitmap),
      crear: vi.fn<CrearLienzo>(
        () =>
          ({
            width: 0,
            height: 0,
            getContext: () => ({ setTransform: () => {}, drawImage: () => {} }),
            toBlob: (cb: (b: Blob | null) => void) => cb(null),
          }) as unknown as HTMLCanvasElement,
      ),
    });
    expect(c.file).toBe(antes);
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo girar la imagen.");
  });

  it("relectura con id ausente: no-op silenciosa", async () => {
    const aviso = document.getElementById("aviso");
    if (aviso) {
      aviso.textContent = "";
    }
    await expect(releerTrasEdicion(999_999, new Blob(["x"]))).resolves.toBeUndefined();
    expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
    expect(vi.mocked(renderHojas)).not.toHaveBeenCalled();
    expect(document.getElementById("aviso")?.textContent).toBe("");
  });

  it("reapertura que lanza: conserva el texto leído y el ok, sin aviso", async () => {
    vi.useFakeTimers();
    const { deps } = depsGiro();
    const c = sembrar();
    await girarYReleer(c.id, 90, deps);
    vi.mocked(extraerPendientes).mockImplementationOnce(() => {
      throw new Error("lote caído");
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(c.textoOcr).toBe("TOTAL LEÍDO");
    expect(c.estado).toBe("ok");
    expect(document.getElementById("aviso")?.textContent).toBe("");
  });

  it("item muerto durante el drenaje: el OCR no corre sobre un blob muerto", async () => {
    vi.useFakeTimers();
    const c = sembrar();
    state.colaEnProceso = true;
    try {
      const p = releerTrasEdicion(c.id, new Blob(["x"]));
      // la relectura espera su turno (cola activa)
      await vi.advanceTimersByTimeAsync(250);
      // el item murió mientras la cola trabajaba
      state.hojas = [crearHoja()];
      state.colaEnProceso = false;
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(vi.mocked(extraerTexto)).not.toHaveBeenCalled();
      expect(vi.mocked(extraerPendientes)).not.toHaveBeenCalled();
    } finally {
      state.colaEnProceso = false;
      vi.useRealTimers();
    }
  });
});
