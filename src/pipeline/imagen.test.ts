/* Tests: imagen — normalización JPEG única, tope 2000px, filtro blancas/corruptas. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CALIDAD_JPEG, LADO_MAX_IMAGEN, normalizarImagen, recortarMargenesBlancos } from "./imagen";
import type { CargarBitmap, CrearLienzo } from "./imagen";

function bitmapFalso(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: vi.fn() } as unknown as ImageBitmap;
}

// Lienzo falso: píxeles dados, captura tipo/calidad del toBlob.
function lienzoFalso(pixeles: number[]): {
  crear: () => HTMLCanvasElement;
  tipo: () => string | null;
  calidad: () => unknown;
} {
  let tipo: string | null = null;
  let calidad: unknown = null;
  const datos = new Uint8ClampedArray(pixeles);
  const lienzo = {
    width: 0,
    height: 0,
    getContext: (): unknown => ({
      drawImage: (): void => {},
      getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
    }),
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
  };
}

const px = (n: number, r: number, g: number, b: number, a = 255): number[] =>
  Array.from({ length: n }, () => [r, g, b, a]).flat();
// Muestreo cada 4px: el píxel 0 siempre se cuenta → tinta ahí = no blanca.
const conTinta: number[] = [...px(1, 0, 0, 0), ...px(15, 255, 255, 255)];
const todoBlanco: number[] = px(16, 255, 255, 255);

const cargar =
  (w: number, h: number): CargarBitmap =>
  async (_f, opc) => {
    ultimaOpc = opc;
    return bitmapFalso(w, h);
  };
let ultimaOpc: ImageBitmapOptions | undefined;
beforeEach(() => {
  ultimaOpc = undefined;
});
const img = (nombre: string, type: string): File => new File(["x"], nombre, { type });

describe("normalizarImagen", () => {
  it("chica conserva dimensiones y sale jpeg 0.9", async () => {
    const falso = lienzoFalso(conTinta);
    const blob = await normalizarImagen(img("a.png", "image/png"), cargar(100, 80), falso.crear);
    expect(blob.type).toBe("image/jpeg");
    expect(falso.tipo()).toBe("image/jpeg");
    expect(falso.calidad()).toBe(CALIDAD_JPEG);
    // Guard de regresión: sin from-image el EXIF no se endereza.
    expect(ultimaOpc).toEqual({ imageOrientation: "from-image" });
  });

  it("grande se acota al tope manteniendo proporción", async () => {
    const falso = lienzoFalso(conTinta);
    await normalizarImagen(img("g.jpg", "image/jpeg"), cargar(4000, 3000), falso.crear);
    const lienzo = falso.crear();
    expect(lienzo.width).toBe(LADO_MAX_IMAGEN);
    expect(lienzo.height).toBe(1500);
  });

  it("blanca lanza sin producir blob", async () => {
    const falso = lienzoFalso(todoBlanco);
    await expect(
      normalizarImagen(img("b.png", "image/png"), cargar(100, 80), falso.crear),
    ).rejects.toThrow("blanca");
  });

  it("negra llena lanza como blanca (mismo aviso)", async () => {
    const falso = lienzoFalso(px(16, 0, 0, 0));
    await expect(
      normalizarImagen(img("n2.png", "image/png"), cargar(100, 80), falso.crear),
    ).rejects.toThrow("blanca");
  });

  it("gris app #f7f8fa lleno lanza como blanca", async () => {
    const gris: number[] = Array.from({ length: 16 }, () => [247, 248, 250, 255]).flat();
    const falso = lienzoFalso(gris);
    await expect(
      normalizarImagen(img("g2.png", "image/png"), cargar(100, 80), falso.crear),
    ).rejects.toThrow("blanca");
  });

  it("decode roto lanza ilegible", async () => {
    const roto: CargarBitmap = async () => {
      throw new Error("rota");
    };
    await expect(normalizarImagen(img("r.png", "image/png"), roto)).rejects.toThrow("ilegible");
  });

  it("sin contexto 2d o toBlob nulo lanza ilegible", async () => {
    const sinCtx = {
      width: 0,
      height: 0,
      getContext: (): null => null,
    } as unknown as HTMLCanvasElement;
    await expect(
      normalizarImagen(img("c.png", "image/png"), cargar(10, 10), () => sinCtx),
    ).rejects.toThrow("ilegible");
    const { crear } = lienzoFalso(conTinta);
    const base = crear();
    const lienzoNulo = {
      width: base.width,
      height: base.height,
      getContext: (): unknown => base.getContext("2d"),
      toBlob: (cb: (b: Blob | null) => void): void => cb(null),
    } as unknown as HTMLCanvasElement;
    await expect(
      normalizarImagen(img("n.png", "image/png"), cargar(10, 10), () => lienzoNulo),
    ).rejects.toThrow("ilegible");
  });
});

describe("recortarMargenesBlancos", () => {
  /** Foto 40x30 con bloque amplio (x5-34, y5-24) = foto sobre fondo dado. */
  type Pintar = (x: number, y: number) => readonly [number, number, number];
  function lienzoConMarco(
    pintar: Pintar = () => [255, 255, 255],
    bloque: Pintar = () => [0, 0, 0],
  ): { src: HTMLCanvasElement; dibujos: unknown[][] } {
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const tinta = x >= 5 && x <= 34 && y >= 5 && y <= 24;
        const i = (y * w + x) * 4;
        const [r, g, b] = tinta ? bloque(x, y) : pintar(x, y);
        datos[i] = r;
        datos[i + 1] = g;
        datos[i + 2] = b;
        datos[i + 3] = 255;
      }
    }
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const crear: CrearLienzo = () => salida;
    return { src: recortarMargenesBlancos(src, crear), dibujos };
  }

  it("marco blanco → recorta al bbox exacto", () => {
    const { src, dibujos } = lienzoConMarco();
    // bbox x5-34/y5-24 sin margen → sx5 sy5 w30 h20
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("margen morado degradado #30007a→#6001d9 → recorta al contenido", () => {
    const { src, dibujos } = lienzoConMarco((x) => {
      const t = x / 39;
      return [Math.round(48 + 48 * t), Math.round(t), Math.round(122 + 95 * t)];
    });
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("margen negro con texto → recorta hasta la tinta (come el aire)", () => {
    // Rectángulo blanco con 4 líneas de texto (x8-32): el aire superior e
    // izquierdo se come; el bbox ciñe el bloque de tinta (x8-32/y8-20).
    const { src, dibujos } = lienzoConMarco(
      () => [0, 0, 0],
      (x, y) => ([8, 12, 16, 20].includes(y) && x >= 8 && x <= 32 ? [0, 0, 0] : [255, 255, 255]),
    );
    expect(src.width).toBe(25);
    expect(src.height).toBe(13);
    expect(dibujos[0]?.slice(1)).toEqual([8, 8, 25, 13, 0, 0, 25, 13]);
  });

  it("marco morado BancoSol con marca de agua → ciñe el texto", () => {
    // Réplica medida (marco #30007a 10px, tarjeta blanca, marca Δ~22, tinta):
    // el marco, el aire y la marca ceden; frena la primera fila con tinta.
    const w = 120;
    const h = 90;
    const datos = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const marco = x < 10 || x >= w - 10 || y < 10 || y >= h - 10;
        const tinta = !marco && x >= 20 && x <= 100 && y >= 35 && y <= 60;
        const marca = !marco && !tinta && (y - 12) % 7 === 0;
        const [r, g, b] = marco
          ? [48, 0, 122]
          : tinta
            ? [0, 0, 0]
            : marca
              ? [233, 229, 241]
              : [255, 255, 255];
        datos[i] = r;
        datos[i + 1] = g;
        datos[i + 2] = b;
        datos[i + 3] = 255;
      }
    }
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const out = recortarMargenesBlancos(src, () => salida);
    expect(out.width).toBe(81);
    expect(out.height).toBe(26);
    expect(dibujos[0]?.slice(1)).toEqual([20, 35, 81, 26, 0, 0, 81, 26]);
  });

  it("cabecera oscura con texto claro no se decapita", () => {
    // Fila 0 morada con texto blanco (con contadores morados, como glifos
    // reales) + bloque oscuro x10-30/y8-12: la fila 0 se conserva (sy=0),
    // los laterales ceden y el bbox ciñe el bloque (x10-30/y0-12).
    const w = 40;
    const h = 20;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const pintar = (x: number, y: number, r: number, g: number, b: number): void => {
      const i = (y * w + x) * 4;
      datos[i] = r;
      datos[i + 1] = g;
      datos[i + 2] = b;
    };
    for (let x = 0; x < w; x += 1) pintar(x, 0, 96, 1, 217);
    for (let x = 18; x <= 22; x += 1) pintar(x, 0, 255, 255, 255);
    pintar(20, 0, 96, 1, 217);
    for (let y = 8; y <= 12; y += 1) {
      for (let x = 10; x <= 30; x += 1) pintar(x, y, 0, 0, 0);
    }
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const out = recortarMargenesBlancos(src, () => salida);
    expect(out.width).toBe(21);
    expect(out.height).toBe(13);
    expect(dibujos[0]?.slice(1)).toEqual([10, 0, 21, 13, 0, 0, 21, 13]);
  });

  it("artefacto JPEG de borde (Δ44-50) no veta columnas", () => {
    // Réplica BancoSol-1: marco morado + tarjeta con tinta + 1px de ruido en
    // la última fila. Sin perdón, cada columna colapsa a ese píxel y x0/x1 se
    // clavan en los bordes (marcos intactos); con perdón ciñe (x14-46/y14-26).
    const w = 60;
    const h = 40;
    const datos = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const tarjeta = x >= 8 && x <= 51 && y >= 8 && y <= 31;
        const tinta = tarjeta && x >= 14 && x <= 46 && y >= 14 && y <= 26;
        const [r, g, b] = tinta ? [0, 0, 0] : tarjeta ? [255, 255, 255] : [48, 0, 122];
        datos[i] = r;
        datos[i + 1] = g;
        datos[i + 2] = b;
        datos[i + 3] = 255;
      }
    }
    const ruido = (x: number, r: number, g: number, b: number): void => {
      const i = ((h - 1) * w + x) * 4;
      datos[i] = r;
      datos[i + 1] = g;
      datos[i + 2] = b;
    };
    ruido(3, 93, 45, 167);
    ruido(56, 98, 50, 172);
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const out = recortarMargenesBlancos(src, () => salida);
    expect(out.width).toBe(33);
    expect(out.height).toBe(13);
    expect(dibujos[0]?.slice(1)).toEqual([14, 14, 33, 13, 0, 0, 33, 13]);
  });

  it("mota de 2px no es aire (frena conservador)", () => {
    // Trazo negro de 2px en la fila 0 + bloque x5-16/y5-8: la fila 0 se
    // conserva (sy=0); el bbox ciñe lo demás (x5-16/y0-8).
    const w = 22;
    const h = 10;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const pintar = (x: number, y: number): void => {
      const i = (y * w + x) * 4;
      datos[i] = 0;
      datos[i + 1] = 0;
      datos[i + 2] = 0;
    };
    pintar(10, 0);
    pintar(11, 0);
    for (let y = 5; y <= 8; y += 1) {
      for (let x = 5; x <= 16; x += 1) pintar(x, y);
    }
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const out = recortarMargenesBlancos(src, () => salida);
    expect(out.width).toBe(12);
    expect(out.height).toBe(9);
    expect(dibujos[0]?.slice(1)).toEqual([5, 0, 12, 9, 0, 0, 12, 9]);
  });

  it("todo blanco → devuelve el mismo lienzo", () => {
    const datos = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    const src = {
      width: 10,
      height: 10,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    expect(
      recortarMargenesBlancos(src, () => {
        throw new Error("no debe crear lienzo");
      }),
    ).toBe(src);
  });

  it("tinta a borde → nada que recortar", () => {
    const w = 10;
    const h = 10;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    // Bloques 2x2 en esquinas opuestas (bbox = lienzo completo).
    for (const [bx, by] of [
      [0, 0],
      [8, 8],
    ] as const) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const i = ((by + dy) * w + (bx + dx)) * 4;
          datos[i] = 0;
          datos[i + 1] = 0;
          datos[i + 2] = 0;
        }
      }
    }
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    expect(
      recortarMargenesBlancos(src, () => {
        throw new Error("no debe crear lienzo");
      }),
    ).toBe(src);
  });

  it("tinta en impares → bbox exacto (regresión paso 2)", () => {
    // L en x=11/y=7 impares: con paso 2 filas y columnas enteras se ven blancas.
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const tinta = (x: number, y: number): void => {
      const i = (y * w + x) * 4;
      datos[i] = 0;
      datos[i + 1] = 0;
      datos[i + 2] = 0;
    };
    for (let y = 5; y <= 24; y += 1) tinta(11, y);
    for (let x = 5; x <= 34; x += 1) tinta(x, 7);
    const dibujos: unknown[][] = [];
    const salida = {
      width: 0,
      height: 0,
      getContext: (): unknown => ({
        drawImage: (...a: unknown[]): void => {
          dibujos.push(a);
        },
      }),
    } as unknown as HTMLCanvasElement;
    const src = {
      width: w,
      height: h,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
    } as unknown as HTMLCanvasElement;
    const out = recortarMargenesBlancos(src, () => salida);
    // bbox x5-34/y5-24 sin margen → sx5 sy5 w30 h20
    expect(out.width).toBe(30);
    expect(out.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });
});
