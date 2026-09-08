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
const { girarYReleer } = await import("./rotar");
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
});
