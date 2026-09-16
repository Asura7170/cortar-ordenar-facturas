/* Tests: docaligner — geometría pura, decode de heatmap sintético y paso completo con stubs (sin onnx). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  areaQuad,
  bitmapATensor,
  calcularHomografia,
  conBorde,
  conTimeout,
  decodificarHeatmap,
  descargarConCache,
  descargarPesos,
  borrarModelos,
  detectarYRecortar,
  esConvexo,
  esQuadPlausible,
  iniciarSesion,
  LADO_MODELO,
  olvidarSesionFallida,
  ordenarQuad,
  PAD_BORDE,
  quitarBorde,
  rectificar,
  reintentarEps,
  tamanoModelos,
  tamanoSalida,
  UMBRAL_HEATMAP,
  URL_MODELO_HF,
  warpear,
} from "./docaligner";
import type { BuferPixeles, IntentarEp, Quad, SesionDetectora } from "./docaligner";

// jsdom no trae ImageData: stub mínimo (data/w/h es lo único que usamos).
class ImageDataFalso {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(datos: Uint8ClampedArray, w: number, h: number) {
    this.data = datos;
    this.width = w;
    this.height = h;
  }
}
vi.stubGlobal("ImageData", ImageDataFalso as unknown as typeof ImageData);

beforeEach(() => {
  reintentarEps();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const esquinas = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w - 1, y: 0 },
  { x: w - 1, y: h - 1 },
  { x: 0, y: h - 1 },
];

function bitmapFalso(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}

// Lienzo falso: píxeles dados, captura tipo/calidad del toBlob y trazos de dibujo.
function lienzoFalso(pixeles: Uint8ClampedArray): {
  crear: () => HTMLCanvasElement;
  tipo: () => string | null;
  calidad: () => unknown;
  puesto: () => { datos: Uint8ClampedArray; w: number; h: number } | null;
  relleno: () => string;
  rect: () => number[] | null;
  dibujo: () => unknown[] | null;
} {
  let tipo: string | null = null;
  let calidad: unknown = null;
  let puesto: { datos: Uint8ClampedArray; w: number; h: number } | null = null;
  let relleno = "";
  let rect: number[] | null = null;
  let dibujo: unknown[] | null = null;
  const ctx = {
    drawImage: (...args: unknown[]): void => {
      dibujo = args;
    },
    fillRect: (...args: number[]): void => {
      rect = args;
    },
    get fillStyle(): string {
      return relleno;
    },
    set fillStyle(v: string) {
      relleno = v;
    },
    getImageData: (_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } => {
      // Tras un put (el warp de rectificar), se lee lo puesto si encaja en dims.
      if (puesto && puesto.w === w && puesto.h === h) return { data: puesto.datos };
      // Si el lienzo pide más píxeles de los dados, se completa en negro (?? 0 del lector).
      if (pixeles.length >= w * h * 4) return { data: pixeles };
      const ext = new Uint8ClampedArray(w * h * 4);
      ext.set(pixeles);
      return { data: ext };
    },
    putImageData: (img: { data: Uint8ClampedArray }, _x: number, _y: number): void => {
      puesto = { datos: img.data, w: lienzo.width, h: lienzo.height };
    },
  };
  const lienzo = {
    width: 0,
    height: 0,
    getContext: (): unknown => ctx,
    toBlob: (cb: (b: Blob | null) => void, t?: string, q?: unknown): void => {
      tipo = t ?? null;
      calidad = q;
      cb(new Blob(["x"], { type: "image/jpeg" }));
    },
  } as unknown as HTMLCanvasElement;
  return {
    crear: (): HTMLCanvasElement => lienzo,
    tipo: (): string | null => tipo,
    calidad: (): unknown => calidad,
    puesto: () => puesto,
    relleno: () => relleno,
    rect: () => rect,
    dibujo: () => dibujo,
  };
}

const blanco = (w: number, h: number): Uint8ClampedArray =>
  new Uint8ClampedArray(w * h * 4).fill(255);

// Heatmap (1,4,L,L) con un pico por canal en las celdas dadas.
function heatConPicos(L: number, celdas: Array<[number, number]>): Float32Array {
  const heat = new Float32Array(4 * L * L);
  celdas.forEach(([cx, cy], c) => {
    heat[c * L * L + cy * L + cx] = 1;
  });
  return heat;
}

describe("ordenarQuad/esConvexo", () => {
  it("ordena como sup-izq, sup-der, inf-der, inf-izq", () => {
    const q = ordenarQuad([
      { x: 9, y: 9 },
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 0, y: 9 },
    ]);
    expect(q).toEqual([
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 9 },
      { x: 0, y: 9 },
    ]);
  });

  it("rechaza el quad autointersecado", () => {
    expect(esConvexo(esquinas(10, 10))).toBe(true);
    expect(
      esConvexo([
        { x: 0, y: 0 },
        { x: 9, y: 9 },
        { x: 9, y: 0 },
        { x: 0, y: 9 },
      ]),
    ).toBe(false);
  });
});

describe("esQuadPlausible", () => {
  it("acepta el marco casi completo con confianza", () => {
    // Inset 2px: el área (0.90) queda bajo el tope 0.98 (un quad al 100% exacto no es plausible).
    const marco: Quad = [
      { x: 2, y: 2 },
      { x: 97, y: 2 },
      { x: 97, y: 97 },
      { x: 2, y: 97 },
    ];
    expect(esQuadPlausible(marco, [0.9, 0.9, 0.9, 0.9], 100, 100)).toBe(true);
  });

  it("rechaza null, diminuto y confianza baja", () => {
    expect(esQuadPlausible(null, [], 100, 100)).toBe(false);
    expect(esQuadPlausible(esquinas(4, 4), [0.9, 0.9, 0.9, 0.9], 100, 100)).toBe(false);
    expect(esQuadPlausible(esquinas(100, 100), [0.9, 0.1, 0.9, 0.9], 100, 100)).toBe(false);
  });
});

describe("tamanoSalida/areaQuad", () => {
  it("usa la media de aristas opuestas", () => {
    expect(tamanoSalida(esquinas(101, 51))).toEqual({ width: 100, height: 50 });
    expect(areaQuad(esquinas(101, 51))).toBe(100 * 50);
  });
});

describe("calcularHomografia", () => {
  it("lanza con puntos degenerados", () => {
    const linea: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(() => calcularHomografia(linea, linea)).toThrow();
  });
});

describe("warpear", () => {
  it("identidad conserva los píxeles", () => {
    const w = 4;
    const h = 4;
    const datos = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      datos[i * 4] = i * 10;
      datos[i * 4 + 1] = i * 5;
      datos[i * 4 + 2] = i;
      datos[i * 4 + 3] = 255;
    }
    const fuera = warpear({ datos, ancho: w, alto: h }, esquinas(w, h), w, h);
    // La homografía se resuelve por Gauss: error ~1e-13 que el redondeo a u8 puede mover ±1.
    for (let i = 0; i < fuera.datos.length; i++) {
      expect(Math.abs((fuera.datos[i] ?? 0) - (datos[i] ?? 0))).toBeLessThanOrEqual(1);
    }
  });

  it("fuera del quad → blanco (parcial o total)", () => {
    const w = 8;
    const h = 8;
    const src: BuferPixeles = {
      datos: new Uint8ClampedArray(w * h * 4).fill(0),
      ancho: w,
      alto: h,
    };
    // Quad que sobresale del marco (típico: documento al borde de la foto).
    const fueraMarco: Quad = [
      { x: -2, y: -2 },
      { x: 9, y: -2 },
      { x: 9, y: 9 },
      { x: -2, y: 9 },
    ];
    const grande = warpear(src, fueraMarco, 8, 8);
    // Esquina (0,0) de la salida mapea a (-2,-2), fuera de la fuente → blanco opaco.
    expect([grande.datos[0], grande.datos[1], grande.datos[2], grande.datos[3]]).toEqual([
      255, 255, 255, 255,
    ]);
    // Centro mapea dentro → negro de la fuente.
    const c = (4 * 8 + 4) * 4;
    expect([
      grande.datos[c],
      grande.datos[c + 1],
      grande.datos[c + 2],
      grande.datos[c + 3],
    ]).toEqual([0, 0, 0, 255]);
    // Todo fuera → todo blanco.
    const lejos: Quad = [
      { x: 20, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 30 },
      { x: 20, y: 30 },
    ];
    expect(Array.from(warpear(src, lejos, 4, 4).datos).every((v) => v === 255)).toBe(true);
  });
});

describe("decodificarHeatmap", () => {
  it("localiza los 4 picos cerca de su celda", () => {
    const L = 8;
    const { quad, confianzas } = decodificarHeatmap(
      heatConPicos(L, [
        [1, 1],
        [6, 1],
        [6, 6],
        [1, 6],
      ]),
      [1, 4, L, L],
      80,
      80,
      UMBRAL_HEATMAP,
    );
    expect(confianzas).toEqual([1, 1, 1, 1]);
    expect(quad).not.toBeNull();
    // Celda (1,1) → ((1.5)/8)*80 = 15.
    expect(quad?.[0].x).toBeCloseTo(15, 0);
    expect(quad?.[0].y).toBeCloseTo(15, 0);
  });

  it("vacío → null sin lanzar", () => {
    const { quad } = decodificarHeatmap(new Float32Array(4 * 8 * 8), [1, 4, 8, 8], 80, 80);
    expect(quad).toBeNull();
  });
});

describe("bitmapATensor/rectificar", () => {
  it("tensor CHW 0..1 con el rojo en el primer plano", () => {
    const n = LADO_MODELO * LADO_MODELO;
    const pix = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      pix[i * 4] = 255;
      pix[i * 4 + 3] = 255;
    }
    const falso = lienzoFalso(pix);
    const t = bitmapATensor(bitmapFalso(500, 500), falso.crear);
    expect(t.length).toBe(3 * n);
    expect(t[0]).toBe(1);
    expect(t[n]).toBe(0);
  });

  it("rectificar emite el warp en jpeg", async () => {
    const falso = lienzoFalso(blanco(10, 8));
    const blob = await rectificar(bitmapFalso(10, 8), esquinas(10, 8), falso.crear);
    expect(blob.type).toBe("image/jpeg");
    const p = falso.puesto();
    expect(p?.w).toBe(9);
    expect(p?.h).toBe(7);
  });

  it("rectificar recorta la cuña blanca del quad salido (2º pase)", async () => {
    // Fuente 10x8 con bloque gris (x2-7/y3-6); quad salido 2px por arriba:
    // el warp deja 2 filas blancas y el mismo recorte las quita (sy>0).
    const pix = blanco(10, 8);
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 2; x <= 7; x += 1) {
        const i = (y * 10 + x) * 4;
        pix[i] = 100;
        pix[i + 1] = 100;
        pix[i + 2] = 100;
      }
    }
    const falso = lienzoFalso(pix);
    const blob = await rectificar(
      bitmapFalso(10, 8),
      [
        { x: 0, y: -2 },
        { x: 9, y: -2 },
        { x: 9, y: 7 },
        { x: 0, y: 7 },
      ],
      falso.crear,
    );
    expect(blob.type).toBe("image/jpeg");
    const d = falso.dibujo();
    expect(d?.[1]).toBe(1);
    expect(d?.[2]).toBe(4);
  });
});

describe("detectarYRecortar", () => {
  const original = new Blob(["orig"], { type: "image/jpeg" });
  const cargar = async (): Promise<ImageBitmap> => bitmapFalso(80, 80);

  // Esquinas al borde del heatmap o cortadas por el marco (vía pad 100): ambas recortan.
  it.each([
    {
      celdas: [
        [0, 0],
        [7, 0],
        [7, 7],
        [0, 7],
      ],
    },
    {
      celdas: [
        [2, 2],
        [5, 2],
        [5, 5],
        [2, 5],
      ],
    },
  ])("con picos $celdas devuelve el recorte jpeg", async ({ celdas }) => {
    const L = 8;
    const sesion: SesionDetectora = {
      inferir: async (): Promise<{ datos: Float32Array; dims: readonly number[] }> => ({
        datos: heatConPicos(L, celdas as Array<[number, number]>),
        dims: [1, 4, L, L],
      }),
    };
    const pix = blanco(80, 80);
    const falso = lienzoFalso(pix);
    const fuera = await detectarYRecortar(original, {
      cargar,
      crear: falso.crear,
      sesion: async () => sesion,
    });
    expect(fuera).not.toBe(original);
    expect(fuera.type).toBe("image/jpeg");
  });

  it("sin esquinas o con error devuelve el original", async () => {
    const vacia: SesionDetectora = {
      inferir: async (): Promise<{ datos: Float32Array; dims: readonly number[] }> => ({
        datos: new Float32Array(4 * 8 * 8),
        dims: [1, 4, 8, 8],
      }),
    };
    const rota: SesionDetectora = {
      inferir: async (): Promise<{ datos: Float32Array; dims: readonly number[] }> => {
        throw new Error("ort caído");
      },
    };
    const falso = lienzoFalso(blanco(80, 80));
    expect(
      await detectarYRecortar(original, { cargar, crear: falso.crear, sesion: async () => vacia }),
    ).toBe(original);
    expect(
      await detectarYRecortar(original, { cargar, crear: falso.crear, sesion: async () => rota }),
    ).toBe(original);
  });
});

describe("conTimeout", () => {
  it("resuelve si llega antes del límite", async () => {
    await expect(conTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it("rechaza tras el límite aunque la promesa cuelgue", async () => {
    vi.useFakeTimers();
    try {
      const cuelga = new Promise<number>(() => {});
      const p = expect(conTimeout(cuelga, 1000)).rejects.toThrow("timeout tras 1000ms");
      await vi.advanceTimersByTimeAsync(1000);
      await p;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("iniciarSesion", () => {
  const buena: SesionDetectora = {
    inferir: async (): Promise<{ datos: Float32Array; dims: readonly number[] }> => ({
      datos: new Float32Array(0),
      dims: [],
    }),
  };

  it("usa el primer EP sano sin avisar", async () => {
    const vistos: string[] = [];
    const intentar: IntentarEp = async (ep) => {
      vistos.push(ep);
      return buena;
    };
    await expect(iniciarSesion(intentar, ["webgpu", "wasm"], 1000)).resolves.toBe(buena);
    expect(vistos).toEqual(["webgpu"]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("salta el EP que rechaza y avisa", async () => {
    const vistos: string[] = [];
    const intentar: IntentarEp = async (ep) => {
      vistos.push(ep);
      if (ep === "webgpu") throw new Error("sin GPU");
      return buena;
    };
    await expect(iniciarSesion(intentar, ["webgpu", "wasm"], 1000)).resolves.toBe(buena);
    expect(vistos).toEqual(["webgpu", "wasm"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("webgpu"));
  });

  it("agota el timeout del EP colgado y pasa al siguiente", async () => {
    vi.useFakeTimers();
    try {
      const cuelga = new Promise<SesionDetectora>(() => {});
      const vistos: string[] = [];
      const intentar: IntentarEp = (ep) => {
        vistos.push(ep);
        return ep === "webgpu" ? cuelga : Promise.resolve(buena);
      };
      const p = expect(iniciarSesion(intentar, ["webgpu", "wasm"], 5000)).resolves.toBe(buena);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(vistos).toEqual(["webgpu", "wasm"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no reintenta el EP caído en la misma carga", async () => {
    let intentos = 0;
    const intentar: IntentarEp = async () => {
      intentos += 1;
      throw new Error("caído");
    };
    await expect(iniciarSesion(intentar, ["webgpu"], 100)).rejects.toThrow();
    await expect(iniciarSesion(intentar, ["webgpu", "wasm"], 100)).rejects.toThrow();
    // Solo el primer llamado intentó webgpu; el segundo lo saltó por el latch (wasm = intento 2).
    expect(intentos).toBe(2);
  });

  it("lanza si todos los EPs caen", async () => {
    const intentar: IntentarEp = async () => {
      throw new Error("nada sirve");
    };
    await expect(iniciarSesion(intentar, ["webgpu", "wasm"], 100)).rejects.toThrow("nada sirve");
  });
});

describe("conBorde/quitarBorde", () => {
  it("envuelve en negro con el bitmap desplazado PAD_BORDE", () => {
    const falso = lienzoFalso(blanco(10, 8));
    const lienzo = conBorde(bitmapFalso(10, 8), falso.crear);
    expect(lienzo.width).toBe(10 + PAD_BORDE * 2);
    expect(lienzo.height).toBe(8 + PAD_BORDE * 2);
    expect(falso.relleno()).toBe("#000");
    expect(falso.rect()).toEqual([0, 0, 10 + PAD_BORDE * 2, 8 + PAD_BORDE * 2]);
    const dibujo = falso.dibujo() ?? [];
    expect(dibujo[1]).toBe(PAD_BORDE);
    expect(dibujo[2]).toBe(PAD_BORDE);
  });

  it("resta el borde conservando el orden", () => {
    expect(
      quitarBorde([
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
  });
});

describe("descargarPesos", () => {
  const BYTES = new Uint8Array([1, 2, 3]).buffer;
  type Tienda = Map<
    unknown,
    { arrayBuffer: () => Promise<ArrayBuffer>; headers?: { get: (n: string) => string | null } }
  >;
  // jsdom no trae Response: dummy (el put falso no lo lee).
  class RespuestaFalsa {
    readonly cuerpo: unknown;
    readonly init: unknown;
    constructor(cuerpo: unknown, init?: unknown) {
      this.cuerpo = cuerpo;
      this.init = init;
    }
  }

  function conRed(tienda: Tienda, fetchFn: ReturnType<typeof vi.fn>): () => void {
    const g = globalThis as Record<string, unknown>;
    const real = { fetch: g["fetch"], caches: g["caches"], Response: g["Response"] };
    g["Response"] = RespuestaFalsa;
    g["fetch"] = fetchFn;
    g["caches"] = {
      open: async (): Promise<unknown> => ({
        match: async (k: unknown): Promise<unknown> => {
          const url = typeof k === "string" ? k : (k as { url: string }).url;
          return tienda.get(url) ?? undefined;
        },
        put: async (k: unknown): Promise<void> => {
          tienda.set(k, { arrayBuffer: async () => BYTES });
        },
        keys: async (): Promise<unknown[]> => [...tienda.keys()].map((url) => ({ url })),
        delete: async (k: unknown): Promise<boolean> => tienda.delete(k),
      }),
      delete: async (): Promise<boolean> => {
        const habia = tienda.size > 0;
        tienda.clear();
        return habia;
      },
    };
    return () => {
      g["fetch"] = real.fetch;
      g["Response"] = real.Response;
      if (real.caches === undefined) delete g["caches"];
      else g["caches"] = real.caches;
    };
  }

  const redOk = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => BYTES }));

  it("URL_MODELO_HF es el resolve estable de HF (no el CDN firmado)", () => {
    expect(URL_MODELO_HF).toBe(
      "https://huggingface.co/7rplus/pagescan-weights/resolve/main/fastvit_sa24_h_e_bifpn_256_fp32.onnx",
    );
  });

  it("miss descarga una vez; hit no refetchea", async () => {
    const tienda: Tienda = new Map();
    const fetchFn = redOk();
    const restaurar = conRed(tienda, fetchFn);
    try {
      await expect(descargarConCache("clave-test", 30_000, 2)).resolves.toBe(BYTES);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await expect(descargarConCache("clave-test", 30_000, 2)).resolves.toBe(BYTES);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      restaurar();
    }
  });

  it("sin caches va a red directa", async () => {
    const g = globalThis as Record<string, unknown>;
    const real = { fetch: g["fetch"], caches: g["caches"] };
    delete g["caches"];
    const fetchFn = redOk();
    g["fetch"] = fetchFn;
    try {
      await expect(descargarConCache("clave-test", 30_000, 2)).resolves.toBe(BYTES);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      g["fetch"] = real.fetch;
      if (real.caches !== undefined) g["caches"] = real.caches;
    }
  });

  it("HTTP no-ok lanza", async () => {
    const tienda: Tienda = new Map();
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => BYTES,
    }));
    const restaurar = conRed(tienda, fetchFn);
    try {
      await expect(descargarPesos()).rejects.toThrow("HTTP 404");
    } finally {
      restaurar();
    }
  });

  it("tamanoModelos suma Content-Length (0 si vacía o sin caches)", async () => {
    const tienda: Tienda = new Map([
      ["a", { arrayBuffer: async () => BYTES, headers: { get: () => "100" } }],
      ["b", { arrayBuffer: async () => BYTES, headers: { get: () => "23" } }],
    ]);
    const restaurar = conRed(tienda, redOk());
    try {
      await expect(tamanoModelos()).resolves.toBe(123);
      tienda.clear();
      await expect(tamanoModelos()).resolves.toBe(0);
    } finally {
      restaurar();
    }
    const g = globalThis as Record<string, unknown>;
    const realCaches = g["caches"];
    delete g["caches"];
    try {
      await expect(tamanoModelos()).resolves.toBe(0);
      await expect(borrarModelos()).resolves.toBe(false);
    } finally {
      if (realCaches !== undefined) g["caches"] = realCaches;
    }
  });

  it("borrarModelos vacía y avisa si había algo", async () => {
    const tienda: Tienda = new Map([
      ["a", { arrayBuffer: async () => BYTES, headers: { get: () => "100" } }],
    ]);
    const restaurar = conRed(tienda, redOk());
    try {
      await expect(borrarModelos()).resolves.toBe(true);
      await expect(tamanoModelos()).resolves.toBe(0);
      await expect(borrarModelos()).resolves.toBe(false);
    } finally {
      restaurar();
    }
  });

  it("peso bajo el mínimo no se cachea (reintento refetchea)", async () => {
    const tienda: Tienda = new Map();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => BYTES,
    }));
    const restaurar = conRed(tienda, fetchFn);
    try {
      await expect(descargarPesos()).rejects.toThrow("corrupto");
      expect(tienda.size).toBe(0);
      await expect(descargarPesos()).rejects.toThrow("corrupto");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      restaurar();
    }
  });

  it("dos miss concurrentes hacen un solo fetch", async () => {
    const tienda: Tienda = new Map();
    const fetchFn = redOk();
    const restaurar = conRed(tienda, fetchFn);
    try {
      const [a, b] = await Promise.all([
        descargarConCache("clave-test", 30_000, 2),
        descargarConCache("clave-test", 30_000, 2),
      ]);
      expect(a).toBe(BYTES);
      expect(b).toBe(a);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      restaurar();
    }
  });

  it("put que falla avisa y aun así resuelve", async () => {
    const g = globalThis as Record<string, unknown>;
    const real = { fetch: g["fetch"], caches: g["caches"], Response: g["Response"] };
    g["Response"] = RespuestaFalsa;
    g["fetch"] = redOk();
    g["caches"] = {
      open: async (): Promise<unknown> => ({
        match: async () => undefined,
        put: async (): Promise<void> => {
          throw new Error("quota");
        },
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await descargarConCache("clave-test", 30_000, 2);
      expect(r).toBe(BYTES);
      expect(warn).toHaveBeenCalled();
    } finally {
      g["fetch"] = real.fetch;
      g["Response"] = real.Response;
      if (real.caches === undefined) delete g["caches"];
      else g["caches"] = real.caches;
    }
  });

  it("olvidarSesionFallida expulsa el peso y suelta el latch", async () => {
    const tienda: Tienda = new Map();
    const grande = new ArrayBuffer(60_000_000);
    const restaurar = conRed(
      tienda,
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => grande })),
    );
    try {
      await descargarPesos();
      expect(tienda.size).toBe(1);
      let intentos = 0;
      const caido: IntentarEp = async () => {
        intentos += 1;
        throw new Error("create corrupto");
      };
      await expect(iniciarSesion(caido, ["webgpu"], 50)).rejects.toThrow();
      expect(intentos).toBe(1);
      await olvidarSesionFallida();
      expect(tienda.size).toBe(0);
      await expect(iniciarSesion(caido, ["webgpu"], 50)).rejects.toThrow();
      expect(intentos).toBe(2); // latch suelto: webgpu se reintenta
    } finally {
      restaurar();
    }
  });

  it("hit infradimensionado se expulsa y refetchea", async () => {
    const tienda: Tienda = new Map([
      ["k", { arrayBuffer: async () => BYTES, headers: { get: () => "3" } }],
    ]);
    const grande = new ArrayBuffer(60_000_000);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => grande,
    }));
    const restaurar = conRed(tienda, fetchFn);
    try {
      const r = await descargarConCache("k", 30_000, 50_000_000);
      expect(r).toBe(grande);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // el put falso guarda 3B: se siembra la buena a mano y el hit ya no refetchea.
      tienda.set("k", { arrayBuffer: async () => grande, headers: { get: () => "60000000" } });
      await expect(descargarConCache("k", 30_000, 50_000_000)).resolves.toBe(grande);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      restaurar();
    }
  });

  it("no resuelve antes de persistir el put", async () => {
    const tienda: Tienda = new Map();
    let abrir!: () => void;
    const puerta = new Promise<void>((res) => {
      abrir = res;
    });
    const g = globalThis as Record<string, unknown>;
    const real = { fetch: g["fetch"], caches: g["caches"], Response: g["Response"] };
    g["Response"] = RespuestaFalsa;
    g["fetch"] = redOk();
    g["caches"] = {
      open: async (): Promise<unknown> => ({
        match: async () => undefined,
        put: async (k: unknown): Promise<void> => {
          await puerta;
          tienda.set(k, { arrayBuffer: async () => BYTES });
        },
      }),
    };
    try {
      const p = descargarConCache("k", 30_000, 2);
      await new Promise((res) => setTimeout(res, 10));
      expect(tienda.size).toBe(0); // fetch listo, put atascado
      abrir();
      await expect(p).resolves.toBe(BYTES);
      expect(tienda.size).toBe(1);
    } finally {
      g["fetch"] = real.fetch;
      g["Response"] = real.Response;
      if (real.caches === undefined) delete g["caches"];
      else g["caches"] = real.caches;
    }
  });
});
