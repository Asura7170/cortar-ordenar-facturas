/* Tests: ocr — orquestación con sesiones y lienzos falsos (sin onnx ni DOM).
   El modelo real se valida en Chrome con image-test/. */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  bgrDesdeRgba,
  diagVacio,
  enderezar,
  envolver,
  extraerTexto,
  reconocerCaja,
  reconocerLote,
  tamanoDet,
  tensorDet,
  tensorDetDesdeRgba,
} from "./ocr";
import type { NucleoOcr, SalidaOcr, SubsesionOcr } from "./ocr";
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
    const diag = diagVacio();
    const texto = await extraerTexto(new Blob(["x"]), deps, undefined, diag);
    expect(texto).toBe("AA");
    expect(espia.det).toEqual([[[1, 3, 32, 64]]]);
    expect(espia.rec).toHaveLength(1);
    expect((espia.rec[0] as number[][])?.[0]?.slice(0, 3)).toEqual([1, 3, 48]);
    expect(transforms).toHaveLength(1); // warp afín aplicado
    expect(diag).toEqual({ cajas: 1, lote: 1, anchoMax: 320, fallback: false, recRuns: 1 });
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
    lienzo.width = 32; // en prod ver() siempre fija dims (mínimo 32)
    lienzo.height = 32;
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

  it("reuse del enderezado: sin lienzo temporal, solo el del recorte (hilo #4)", async () => {
    const { deps } = base();
    const { lienzo } = lienzoFalso(BLANCO32);
    lienzo.width = 32; // en prod ver() siempre fija dims (mínimo 32)
    lienzo.height = 32;
    let creados = 0;
    let decodes = 0;
    const sinTemporal = {
      ...deps,
      cargar: (): Promise<ImageBitmap> => {
        decodes += 1;
        return Promise.resolve(bitmapFalso(64, 32));
      },
      crear: (): HTMLCanvasElement => {
        creados += 1;
        return lienzo;
      },
    };
    const texto = await extraerTexto(new Blob(["x"]), sinTemporal, {
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
    expect(creados).toBe(1); // solo recorteCaja; antes eran 2 (base temporal + recorte)
    expect(decodes).toBe(0); // Fase 2: en reuse no se decodifica el blob
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

describe("reconocerLote", () => {
  const caja10 = (
    puntaje: number,
  ): { poli: [[0, 0], [10, 0], [10, 10], [0, 10]]; puntaje: number } => ({
    poli: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    puntaje,
  });

  /** Logits bacheados [2,3,n] que deletrean "AA" en cada lote. */
  function logitsLoteAA(): { data: Float32Array; dims: number[] } {
    const n = DICT_OCR.length;
    const idxA = DICT_OCR.indexOf("A");
    const data = new Float32Array(2 * 3 * n);
    data[idxA] = 0.9;
    data[2 * n + idxA] = 0.8;
    data[3 * n + idxA] = 0.7;
    data[5 * n + idxA] = 0.6;
    return { data, dims: [2, 3, n] };
  }

  it("2 cajas → un solo run con batch [2,3,48,320] (L2)", async () => {
    const espia = { det: [] as unknown[][], rec: [] as unknown[][] };
    const nucleo = nucleoFalso(mapaUnaLinea(), logitsLoteAA(), espia);
    const { lienzo } = lienzoFalso(BLANCO32);
    const diag = diagVacio();
    const rs = await reconocerLote(
      nucleo.rec,
      lienzo,
      [caja10(0.9), caja10(0.8)],
      () => lienzo,
      diag,
    );
    expect(rs.map((r) => r.texto)).toEqual(["AA", "AA"]);
    expect(espia.rec).toHaveLength(1);
    expect((espia.rec[0] as number[][])?.[0]).toEqual([2, 3, 48, 320]);
    expect(diag).toEqual({ cajas: 0, lote: 2, anchoMax: 320, fallback: false, recRuns: 1 });
  });

  it("lote rechazado → fallback individual sin lanzar (L2)", async () => {
    const llamadas: number[][] = [];
    const rec: SubsesionOcr = {
      tensor: (datos: Float32Array, formas: readonly number[]): unknown => ({
        datos,
        formas: [...formas],
      }),
      run: (feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>> => {
        const formas = (feeds["x"] as { formas: number[] }).formas;
        llamadas.push(formas);
        if ((formas[0] ?? 0) > 1) return Promise.reject(new Error("sin batch"));
        return Promise.resolve({ fetch_name_0: logitsAA() });
      },
    };
    const { lienzo } = lienzoFalso(BLANCO32);
    const diag = diagVacio();
    const rs = await reconocerLote(rec, lienzo, [caja10(0.9), caja10(0.8)], () => lienzo, diag);
    expect(rs.map((r) => r.texto)).toEqual(["AA", "AA"]);
    expect(llamadas).toHaveLength(3); // 1 lote + 2 individuales
    expect(llamadas[0]?.[0]).toBe(2);
    // Hilo #3: el lote fallido también es un run (antes se omitía).
    expect(diag).toEqual({ cajas: 0, lote: 2, anchoMax: 320, fallback: true, recRuns: 3 });
  });

  it("fallback conserva chunks exitosos y cuenta el chunk fallido (hilo #3)", async () => {
    const llamadas: number[][] = [];
    let n = 0;
    const clases = DICT_OCR.length;
    const idxA = DICT_OCR.indexOf("A");
    const rec: SubsesionOcr = {
      tensor: (datos: Float32Array, formas: readonly number[]): unknown => ({
        datos,
        formas: [...formas],
      }),
      run: (feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>> => {
        const formas = (feeds["x"] as { formas: number[] }).formas;
        llamadas.push(formas);
        n += 1;
        if (n === 2) return Promise.reject(new Error("chunk caído"));
        const b = formas[0] ?? 0;
        const data = new Float32Array(b * 3 * clases);
        for (let k = 0; k < b; k += 1) {
          data[k * 3 * clases + idxA] = 0.9;
          data[(k * 3 + 2) * clases + idxA] = 0.8;
        }
        return Promise.resolve({ fetch_name_0: { data, dims: [b, 3, clases] } });
      },
    };
    const { lienzo } = lienzoFalso(BLANCO32);
    const cajas = Array.from({ length: 20 }, (_, i) => caja10(0.5 + i / 100));
    const diag = diagVacio();
    const rs = await reconocerLote(rec, lienzo, cajas, () => lienzo, diag);
    expect(rs).toHaveLength(20);
    expect(rs.every((r) => r.texto === "AA")).toBe(true);
    // 1 chunk ok [16] + 1 chunk fallido [4] + 4 individuales (solo el caído)
    expect(llamadas).toEqual([
      [16, 3, 48, 320],
      [4, 3, 48, 320],
      [1, 3, 48, 320],
      [1, 3, 48, 320],
      [1, 3, 48, 320],
      [1, 3, 48, 320],
    ]);
    expect(diag).toEqual({ cajas: 0, lote: 20, anchoMax: 320, fallback: true, recRuns: 6 });
  });

  /** rec stub que deletrea "AA" por lote con la forma que le pidan. */
  function recLotes(formasRun: number[][]): SubsesionOcr {
    const n = DICT_OCR.length;
    const idxA = DICT_OCR.indexOf("A");
    return {
      tensor: (datos: Float32Array, formas: readonly number[]): unknown => ({
        datos,
        formas: [...formas],
      }),
      run: (feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>> => {
        const formas = (feeds["x"] as { formas: number[] }).formas;
        formasRun.push(formas);
        const b = formas[0] ?? 0;
        const data = new Float32Array(b * 3 * n);
        for (let k = 0; k < b; k += 1) {
          data[k * 3 * n + idxA] = 0.9;
          data[(k * 3 + 2) * n + idxA] = 0.8;
        }
        return Promise.resolve({ fetch_name_0: { data, dims: [b, 3, n] } });
      },
    };
  }

  it("20 cajas → 2 chunks de 16+4 con el mismo texto (P2)", async () => {
    const formasRun: number[][] = [];
    const { lienzo } = lienzoFalso(BLANCO32);
    const cajas = Array.from({ length: 20 }, (_, i) => caja10(0.5 + i / 100));
    const diag = diagVacio();
    const rs = await reconocerLote(recLotes(formasRun), lienzo, cajas, () => lienzo, diag);
    expect(rs).toHaveLength(20);
    expect(rs.every((r) => r.texto === "AA")).toBe(true);
    expect(formasRun).toEqual([
      [16, 3, 48, 320],
      [4, 3, 48, 320],
    ]);
    expect(diag.recRuns).toBe(2);
    expect(diag.fallback).toBe(false);
  });

  it("la hebra ancha no contamina al resto (P2)", async () => {
    const formasRun: number[][] = [];
    // Búfer que cubre el crop mayor (600×10): el falso ignora el tamaño pedido.
    const { lienzo } = lienzoFalso(new Uint8ClampedArray(600 * 10 * 4).fill(255));
    const ancha = {
      poli: [
        [0, 0],
        [600, 0],
        [600, 10],
        [0, 10],
      ] as const,
      puntaje: 0.9,
    };
    const cajas = [...Array.from({ length: 17 }, () => caja10(0.9)), ancha];
    const rs = await reconocerLote(recLotes(formasRun), lienzo, cajas, () => lienzo);
    expect(rs).toHaveLength(18);
    // 16 angostas con W=320; la ancha (W=1536) queda aislada en el 2º chunk.
    expect(formasRun).toEqual([
      [16, 3, 48, 320],
      [2, 3, 48, 1536],
    ]);
  });

  it("sin cajas válidas → vacíos sin run", async () => {
    const espia = { det: [] as unknown[][], rec: [] as unknown[][] };
    const nucleo = nucleoFalso(mapaUnaLinea(), logitsLoteAA(), espia);
    const { lienzo } = lienzoFalso(BLANCO32);
    expect(await reconocerLote(nucleo.rec, lienzo, [], () => lienzo)).toEqual([]);
    expect(espia.rec).toHaveLength(0);
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

  it("0° baja + 270° alta → gira con 2 det (early-exit, sin 90/180)", async () => {
    const { blob, deps, detLlamadas, lienzos } = base(
      [mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.95],
    );
    const r = await enderezar(blob, deps);
    expect(r.blob).not.toBe(blob);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1]);
    // rot270 del bitmap 64x32: 4º lienzo (rot0, base0, rec0, rot270).
    expect([lienzos[3]?.width, lienzos[3]?.height]).toEqual([32, 64]);
  });

  it("sin OK → gana el más alto (270) con loop completo", async () => {
    const { deps, detLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.65, 0.2, 0.1],
    );
    const r = await enderezar(new Blob(["foto"]), deps);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1, 2, 3]);
  });

  it("todo bajo sin OK → gana el más alto aunque sea bajo (270)", async () => {
    const { blob, deps, detLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.4, 0.2, 0.1],
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

  it("lote rec falla en 270 → reintenta individual y gana 270 (L2)", async () => {
    const { deps, detLlamadas, recLlamadas } = base(
      [mapaUnaLinea(), mapaUnaLinea(), mapaUnaLinea()],
      [0.3, 0.0, 0.95],
      1,
    );
    const r = await enderezar(new Blob(["foto"]), deps);
    expect(r.grados).toBe(270);
    expect(detLlamadas).toEqual([0, 1]);
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
