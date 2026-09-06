/* Tests: ocr — orquestación con sesiones y lienzos falsos (sin onnx ni DOM).
   El modelo real se valida en Chrome con image-test/. */
import { describe, expect, it, vi } from "vite-plus/test";
import { bgrDesdeRgba, extraerTexto, reconocerCaja, tamanoDet, tensorDet } from "./ocr";
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
});
