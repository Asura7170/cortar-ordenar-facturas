/* Tests: docaligner — geometría pura, decode de heatmap sintético y paso completo con stubs (sin onnx). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  areaQuad,
  bitmapATensor,
  calcularHomografia,
  conBorde,
  conTimeout,
  decodificarHeatmap,
  detectarYRecortar,
  esConvexo,
  esQuadPlausible,
  iniciarSesion,
  LADO_MODELO,
  ordenarQuad,
  PAD_BORDE,
  quitarBorde,
  rectificar,
  reintentarEps,
  tamanoSalida,
  UMBRAL_HEATMAP,
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
