/* Tests: ocr — orquestación con sesiones y lienzos falsos (sin onnx ni DOM).
   El modelo real se valida en Chrome con image-test/. */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  bgrDesdeRgba,
  enderezar,
  envolver,
  extraerTexto,
  reconocerCaja,
  tamanoDet,
  tensorDet,
  tensorDetDesdeRgba,
} from "./ocr";
import type { NucleoOcr, SalidaOcr } from "./ocr";
import { DICT_OCR } from "./ocrDict";
import { matrizInversa } from "./ocrRec";

/** Lienzo falso: tamaño asignable, píxeles fijos, captura draws/transforms. */
function lienzoFalso(pixeles: Uint8ClampedArray): {
  lienzo: HTMLCanvasElement;
  draws: unknown[][];
  transforms: number[][];
} {
  const draws: unknown[][] = [];
  const transforms: number[][] = [];
  let w = 0;
  let h = 0;
  const lienzo = {
    get width(): number {
      return w;
    },
    set width(v: number) {
      w = v;
    },
    get height(): number {
      return h;
    },
    set height(v: number) {
      h = v;
    },
    getContext: (): unknown => ({
      drawImage: (...a: unknown[]): void => {
        draws.push(a);
      },
      setTransform: (...a: number[]): void => {
        transforms.push(a);
      },
      getImageData: (): { data: Uint8ClampedArray } => ({ data: pixeles }),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    }),
  } as unknown as HTMLCanvasElement;
  return { lienzo, draws, transforms };
}

function bitmapFalso(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}

/** Mapa 16x8 con rect brillante x2-5/y2-5 (una línea de texto). */
function mapaUnaLinea(): { data: Float32Array; dims: number[] } {
  const data = new Float32Array(16 * 8).fill(0.01);
  for (let y = 2; y <= 5; y += 1) {
    for (let x = 2; x <= 5; x += 1) data[y * 16 + x] = 0.9;
  }
  return { data, dims: [1, 1, 8, 16] };
}

/** Logits que deletrean "AA" (blank en medio separa). */
function logitsAA(): { data: Float32Array; dims: number[] } {
  const n = DICT_OCR.length;
  const data = new Float32Array(3 * n);
  const idxA = DICT_OCR.indexOf("A");
  data[idxA] = 0.9;
  data[2 * n + idxA] = 0.8;
  return { data, dims: [1, 3, n] };
}

/** Núcleo falso que captura feeds y devuelve salidas fijas. */
function nucleoFalso(
  mapa: { data: Float32Array; dims: number[] },
  logits: { data: Float32Array; dims: number[] },
  espia: { det: unknown[][]; rec: unknown[][] },
): NucleoOcr {
  const tensor = (datos: Float32Array, formas: readonly number[]): unknown => ({
    datos,
    formas: [...formas],
  });
  return {
    det: {
      tensor,
      run: (feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>> => {
        espia.det.push([(feeds["x"] as { formas: number[] }).formas]);
        return Promise.resolve({ fetch_name_0: mapa });
      },
    },
    rec: {
      tensor,
      run: (feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>> => {
        espia.rec.push([(feeds["x"] as { formas: number[] }).formas]);
        return Promise.resolve({ fetch_name_0: logits });
      },
    },
  };
}

const BLANCO32 = new Uint8ClampedArray(32 * 32 * 4).fill(255);

describe("tamanoDet", () => {
  it("2000x1000 → 960x480 (solo reduce, múltiplo de 32)", () => {
    expect(tamanoDet(2000, 1000)).toEqual({ w: 960, h: 480 });
  });

  it("100x50 → 96x64", () => {
    expect(tamanoDet(100, 50)).toEqual({ w: 96, h: 64 });
  });

  it("10x10 → mínimo 32", () => {
    expect(tamanoDet(10, 10)).toEqual({ w: 32, h: 32 });
  });

  it("cero → cero", () => {
    expect(tamanoDet(0, 5)).toEqual({ w: 0, h: 0 });
  });
});

describe("bgrDesdeRgba", () => {
  it("rota canales e ignora alfa", () => {
    expect(bgrDesdeRgba(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]))).toEqual(
      new Uint8Array([0, 0, 255, 0, 255, 0]),
    );
  });
});

describe("tensorDet", () => {
  it("blanco 1x1 → (1−media)/std por canal", () => {
    const t = tensorDet(new Uint8Array([255, 255, 255]), 1, 1);
    expect(t[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(t[1]).toBeCloseTo((1 - 0.456) / 0.224, 5);
    expect(t[2]).toBeCloseTo((1 - 0.406) / 0.225, 5);
  });

  it("desde RGBA equivale bit a bit a la vía en 2 pasos", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 10, 20, 30, 255]);
    expect(tensorDetDesdeRgba(rgba, 3, 1)).toEqual(tensorDet(bgrDesdeRgba(rgba), 3, 1));
  });
});

describe("envolver", () => {
  const sesion = (shape: ReadonlyArray<number | string>) =>
    ({
      outputMetadata: [{ name: "x", isTensor: true, type: 1, shape }],
    }) as unknown as import("onnxruntime-web").InferenceSession;
  it("rec con clases distintas al dict lanza en init", () => {
    expect(() => envolver({} as never, sesion([100, 80, 999]), "rec")).toThrow(/999 clases/);
  });
  it("rec compatible no lanza", () => {
    expect(() => envolver({} as never, sesion([100, 80, DICT_OCR.length]), "rec")).not.toThrow();
  });
});

describe("matrizInversa", () => {
  it("traslación → traslación opuesta", () => {
    // +0 normaliza el −0 del álgebra (idéntico para canvas).
    expect(matrizInversa([1, 0, 0, 1, 10, 10])?.map((v) => v + 0)).toEqual([1, 0, 0, 1, -10, -10]);
  });

  it("compuesta con la original → identidad sobre p0 y p1", () => {
    const m = [2, 0.5, -0.25, 1.5, 5, 5] as const;
    const inv = matrizInversa([m[0], m[1], m[2], m[3], m[4], m[5]]);
    expect(inv).not.toBeNull();
    const [a, b, c, d, e, f] = inv ?? [0, 0, 0, 0, 0, 0];
    const aplica = (x: number, y: number): [number, number] => [
      m[0] * (a * x + c * y + e) + m[2] * (b * x + d * y + f) + m[4],
      m[1] * (a * x + c * y + e) + m[3] * (b * x + d * y + f) + m[5],
    ];
    const [x, y] = aplica(3, 7);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(7, 9);
  });

  it("degenerada → null", () => {
    expect(matrizInversa([0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe("extraerTexto", () => {
  function base(
    mapa: { data: Float32Array; dims: number[] } = mapaUnaLinea(),
    logits: { data: Float32Array; dims: number[] } = logitsAA(),
  ): {
    deps: {
      cargar: () => Promise<ImageBitmap>;
      crear: () => HTMLCanvasElement;
      nucleo: () => Promise<NucleoOcr>;
    };
    espia: { det: unknown[][]; rec: unknown[][] };
    transforms: number[][];
  } {
    const espia = { det: [] as unknown[][], rec: [] as unknown[][] };
    const { lienzo, transforms } = lienzoFalso(BLANCO32);
    return {
      deps: {
        cargar: () => Promise.resolve(bitmapFalso(64, 32)),
        crear: () => lienzo,
        nucleo: () => Promise.resolve(nucleoFalso(mapa, logits, espia)),
      },
      espia,
      transforms,
    };
  }

  it("una línea → texto con formas de tensor exactas", async () => {
    const { deps, espia, transforms } = base();
    const texto = await extraerTexto(new Blob(["x"]), deps);
    expect(texto).toBe("AA");
    expect(espia.det).toEqual([[[1, 3, 32, 64]]]);
    expect(espia.rec).toHaveLength(1);
    expect((espia.rec[0] as number[][])?.[0]?.slice(0, 3)).toEqual([1, 3, 48]);
    expect(transforms).toHaveLength(1); // warp afín aplicado
  });

  it("mapa vacío → sin texto y sin rec", async () => {
    const vacio = { data: new Float32Array(16 * 8).fill(0.01), dims: [1, 1, 8, 16] };
    const { deps, espia } = base(vacio, logitsAA());
    expect(await extraerTexto(new Blob(["x"]), deps)).toBe("");
    expect(espia.rec).toHaveLength(0);
  });

  it("rec todo blank → línea vacía filtrada", async () => {
    const n = DICT_OCR.length;
    const { deps } = base(mapaUnaLinea(), { data: new Float32Array(n), dims: [1, 1, n] });
    expect(await extraerTexto(new Blob(["x"]), deps)).toBe("");
  });

  it("núcleo caído → sin lanzar", async () => {
    const { lienzo } = lienzoFalso(BLANCO32);
    const texto = await extraerTexto(new Blob(["x"]), {
      cargar: () => Promise.resolve(bitmapFalso(64, 32)),
      crear: () => lienzo,
      nucleo: () => Promise.reject(new Error("sin EP")),
    });
    expect(texto).toBe("");
  });

  it("miniatura → sin texto", async () => {
    const { lienzo } = lienzoFalso(BLANCO32);
    const texto = await extraerTexto(new Blob(["x"]), {
      cargar: () => Promise.resolve(bitmapFalso(4, 4)),
      crear: () => lienzo,
      nucleo: () => Promise.resolve(nucleoFalso(mapaUnaLinea(), logitsAA(), { det: [], rec: [] })),
    });
    expect(texto).toBe("");
  });

  it("reuse del enderezado: no repite el det (L1)", async () => {
    const { deps, espia } = base();
    const { lienzo } = lienzoFalso(BLANCO32);
    const texto = await extraerTexto(new Blob(["x"]), deps, {
      cajas: [
        {
          poli: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ] as const,
          puntaje: 0.9,
        },
      ],
      base: lienzo,
    });
    expect(texto).toBe("AA");
    expect(espia.det).toHaveLength(0);
    expect(espia.rec).toHaveLength(1);
  });
});

describe("reconocerCaja", () => {
  it("sin contexto → vacío", async () => {
    const espia = { det: [] as unknown[][], rec: [] as unknown[][] };
    const nucleo = nucleoFalso(mapaUnaLinea(), logitsAA(), espia);
    const sinCtx = {
      width: 0,
      height: 0,
      getContext: (): null => null,
    } as unknown as HTMLCanvasElement;
    const base = lienzoFalso(BLANCO32).lienzo;
    const r = await reconocerCaja(
      nucleo.rec,
      base,
      {
        poli: [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        puntaje: 1,
      },
      () => sinCtx,
    );
    expect(r).toEqual({ texto: "", puntaje: 0 });
    expect(espia.rec).toHaveLength(0);
  });

  it("quad inclinado: el crop usa aristas, no bbox", async () => {
    const espia = { det: [] as unknown[][], rec: [] as unknown[][] };
    const nucleo = nucleoFalso(mapaUnaLinea(), logitsAA(), espia);
    let w = 0;
    let h = 0;
    const crear = (): HTMLCanvasElement =>
      ({
        set width(v: number) {
          w = v;
        },
        set height(v: number) {
          h = v;
        },
        getContext: (): unknown => ({
          drawImage: (): void => {},
          setTransform: (): void => {},
          getImageData: (
            _x: number,
            _y: number,
            ww: number,
            hh: number,
          ): { data: Uint8ClampedArray } => ({
            data: new Uint8ClampedArray(ww * hh * 4).fill(255),
          }),
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "high",
        }),
      }) as unknown as HTMLCanvasElement;
    const base = lienzoFalso(BLANCO32).lienzo;
    await reconocerCaja(
      nucleo.rec,
      base,
      {
        poli: [
          [0, 0],
          [200, 17.4],
          [200, 37.4],
          [0, 20],
        ],
        puntaje: 1,
      },
      crear,
    );
    // aristas 200.8×20 → 201×20 (el bbox daría 200×38 y estiraría los glifos).
    expect([w, h]).toEqual([201, 20]);
  });
});

describe("enderezar (decisión rec)", () => {
  /** Lienzo falso con toBlob (registra creaciones en orden). */
  function lienzoConBlob(): {
    crear: () => HTMLCanvasElement;
    lienzos: HTMLCanvasElement[];
  } {
    const lienzos: HTMLCanvasElement[] = [];
    const crear = (): HTMLCanvasElement => {
      let w = 0;
      let h = 0;
      const lienzo = {
        get width(): number {
          return w;
        },
        set width(v: number) {
          w = v;
        },
        get height(): number {
          return h;
        },
        set height(v: number) {
          h = v;
        },
        getContext: (): unknown => ({
          drawImage: (): void => {},
          setTransform: (): void => {},
          getImageData: (): { data: Uint8ClampedArray } => ({ data: BLANCO32 }),
          imageSmoothingEnabled: true,
          imageSmoothingQuality: "high",
        }),
        toBlob: (cb: (b: Blob | null) => void): void => {
          cb(new Blob(["jpg"], { type: "image/jpeg" }));
        },
      } as unknown as HTMLCanvasElement;
      lienzos.push(lienzo);
      return lienzo;
    };
    return { crear, lienzos };
  }

  /** Logits de 1 paso que deletrean una letra con confianza v. */
  function logitsConf(letra: string, v: number): { data: Float32Array; dims: number[] } {
    const n = DICT_OCR.length;
    const data = new Float32Array(n);
    data[DICT_OCR.indexOf(letra)] = v;
    return { data, dims: [1, 1, n] };
  }

  function mapaTenue(): { data: Float32Array; dims: number[] } {
    return { data: new Float32Array(16 * 8).fill(0.01), dims: [1, 1, 8, 16] };
  }

  function mapaCero(): { data: Float32Array; dims: number[] } {
    return { data: new Float32Array(16 * 8), dims: [1, 1, 8, 16] };
  }

  /** Núcleo falso: det por nº de llamada det, rec con conf por nº de llamada rec. */
  function nucleoGiros(
    mapas: Array<{ data: Float32Array; dims: number[] }>,
    confs: number[],
    detLlamadas: number[],
    recLlamadas: number[],
    fallaRecEn?: number,
  ): NucleoOcr {
    const tensor = (datos: Float32Array, formas: readonly number[]): unknown => ({
      datos,
      formas: [...formas],
    });
    let di = 0;
    let ri = 0;
    return {
      det: {
        tensor,
        run: (): Promise<Record<string, SalidaOcr>> => {
          detLlamadas.push(di);
          const m = mapas[Math.min(di, mapas.length - 1)] ?? {
            data: new Float32Array(0),
            dims: [1, 1, 0, 0],
          };
          di += 1;
          return Promise.resolve({ fetch_name_0: m });
        },
      },
      rec: {
        tensor,
        run: (): Promise<Record<string, SalidaOcr>> => {
          recLlamadas.push(ri);
          const n = ri;
          ri += 1;
          if (n === fallaRecEn) return Promise.reject(new Error("rec roto"));
          return Promise.resolve({
            fetch_name_0: logitsConf("A", confs[Math.min(n, confs.length - 1)] ?? 0),
          });
        },
      },
    };
  }

  function base(
    mapas: Array<{ data: Float32Array; dims: number[] }>,
    confs: number[],
    fallaRecEn?: number,
  ): {
    blob: Blob;
    deps: {
      cargar: () => Promise<ImageBitmap>;
      crear: () => HTMLCanvasElement;
      nucleo: () => Promise<NucleoOcr>;
    };
    detLlamadas: number[];
    recLlamadas: number[];
    lienzos: HTMLCanvasElement[];
  } {
    const blob = new Blob(["foto"]);
    const detLlamadas: number[] = [];
    const recLlamadas: number[] = [];
    const { crear, lienzos } = lienzoConBlob();
    return {
      blob,
      deps: {
        cargar: () => Promise.resolve(bitmapFalso(64, 32)),
        crear,
        nucleo: () =>
          Promise.resolve(nucleoGiros(mapas, confs, detLlamadas, recLlamadas, fallaRecEn)),
      },
      detLlamadas,
      recLlamadas,
      lienzos,
    };
  }

  it("0° confiada → mismo blob con cajas/base, 1 det (bypass)", async () => {
    const { blob, deps, detLlamadas, recLlamadas } = base([mapaUnaLinea()], [0.95]);
    const r = await enderezar(blob, deps);
    expect(r.blob).toBe(blob);
    expect(r.grados).toBe(0);
    expect(r.cajas).toHaveLength(1);
    expect(r.base).not.toBeNull();
    expect(detLlamadas).toEqual([0]);
    expect(recLlamadas).toEqual([0]);
  });

  it("0° baja + 90° alta → gira con 2 det (early-exit, sin 270/180)", async () => {
    const { blob, deps, detLlamadas, lienzos } = base(
      [mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.95],
    );
    const r = await enderezar(blob, deps);
    expect(r.blob).not.toBe(blob);
    expect(r.grados).toBe(90);
    expect(detLlamadas).toEqual([0, 1]);
    // rot90 del bitmap 64x32: 4º lienzo (rot0, base0, rec0, rot90).
    expect([lienzos[3]?.width, lienzos[3]?.height]).toEqual([32, 64]);
  });

  it("sin OK → gana el más alto (270) con loop completo", async () => {
    const { deps, detLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.2, 0.65, 0.1],
    );
    const r = await enderezar(new Blob(["foto"]), deps);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1, 2, 3]);
  });

  it("todo bajo sin OK → gana el más alto aunque sea bajo (270)", async () => {
    const { blob, deps, detLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.2, 0.4, 0.1],
    );
    const r = await enderezar(blob, deps);
    expect(r.blob).not.toBe(blob);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1, 2, 3]);
  });

  it("fondo tenue sin cajas → loop completo y quieta", async () => {
    const { blob, deps, detLlamadas, recLlamadas } = base(
      [mapaTenue(), mapaTenue(), mapaTenue(), mapaTenue()],
      [0.95],
    );
    const r = await enderezar(blob, deps);
    expect(r.blob).toBe(blob);
    expect(r.grados).toBe(0);
    expect(detLlamadas).toEqual([0, 1, 2, 3]);
    expect(recLlamadas).toEqual([]);
  });

  it("mapa cero → quieta con 1 det (sin texto: ni giros)", async () => {
    const { blob, deps, detLlamadas, recLlamadas } = base([mapaCero()], [0.95]);
    const r = await enderezar(blob, deps);
    expect(r.blob).toBe(blob);
    expect(r.grados).toBe(0);
    expect(detLlamadas).toEqual([0]);
    expect(recLlamadas).toEqual([]);
  });

  it("rec falla en 90 → se salta y gana 270", async () => {
    const { deps, detLlamadas, recLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.0, 0.95],
      1,
    );
    const r = await enderezar(new Blob(["foto"]), deps);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1, 2]);
    expect(recLlamadas).toEqual([0, 1, 2]);
  });

  it("núcleo caído → quieto sin lanzar", async () => {
    const { crear } = lienzoConBlob();
    const blob = new Blob(["foto"]);
    const r = await enderezar(blob, {
      cargar: () => Promise.resolve(bitmapFalso(64, 32)),
      crear,
      nucleo: () => Promise.reject(new Error("sin EP")),
    });
    expect(r.blob).toBe(blob);
    expect(r.grados).toBe(0);
  });

  it("miniatura → quieta sin det ni rec", async () => {
    const detLlamadas: number[] = [];
    const recLlamadas: number[] = [];
    const { crear } = lienzoConBlob();
    const blob = new Blob(["foto"]);
    const r = await enderezar(blob, {
      cargar: () => Promise.resolve(bitmapFalso(4, 4)),
      crear,
      nucleo: () =>
        Promise.resolve(nucleoGiros([mapaUnaLinea()], [0.95], detLlamadas, recLlamadas)),
    });
    expect(r.blob).toBe(blob);
    expect(r.grados).toBe(0);
    expect(detLlamadas).toEqual([]);
    expect(recLlamadas).toEqual([]);
  });
});
