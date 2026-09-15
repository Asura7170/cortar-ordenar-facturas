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
    const { src, dibujos } = lienzoConMarco(
      () => [255, 255, 255],
      () => [128, 128, 128],
    );
    // bbox x5-34/y5-24 sin margen → sx5 sy5 w30 h20
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("marco negro → recorta al contenido", () => {
    // Negro puro también es fondo: cede igual que el blanco.
    const { src, dibujos } = lienzoConMarco(
      () => [0, 0, 0],
      () => [128, 128, 128],
    );
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("marco negro con ruido JPEG ±8 → recorta (tolerancia)", () => {
    // Ruido leve sigue siendo el color del lado, no tinta.
    const { src, dibujos } = lienzoConMarco(
      (x, y) => [(x + y) % 9, (x * 2 + y) % 8, (x + y * 3) % 9],
      () => [128, 128, 128],
    );
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("marco morado digital uniforme → recorta (cualquier color)", () => {
    const { src, dibujos } = lienzoConMarco(
      () => [48, 0, 122],
      () => [128, 128, 128],
    );
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("lados de distinto color → recorta (cada lado con el suyo)", () => {
    // Izquierda negra, resto blanco: la esquina no bloquea al vecino.
    const { src, dibujos } = lienzoConMarco(
      (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255]),
      () => [128, 128, 128],
    );
    expect(src.width).toBe(30);
    expect(src.height).toBe(20);
    expect(dibujos[0]?.slice(1)).toEqual([5, 5, 30, 20, 0, 0, 30, 20]);
  });

  it("barra uniforme interior ≠ borde → se conserva", () => {
    // Franja gris a ancho completo (y10-12) + bloque (x5-34/y20-24) en
    // página blanca: la franja frena arriba (y0=10), no se come.
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const gris = (x: number, y: number): void => {
      const i = (y * w + x) * 4;
      datos[i] = 128;
      datos[i + 1] = 128;
      datos[i + 2] = 128;
    };
    for (let x = 0; x < w; x += 1) {
      for (let y = 10; y <= 12; y += 1) gris(x, y);
    }
    for (let y = 20; y <= 24; y += 1) {
      for (let x = 5; x <= 34; x += 1) gris(x, y);
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
    expect(out.width).toBe(40);
    expect(out.height).toBe(15);
    expect(dibujos[0]?.slice(1)).toEqual([0, 10, 40, 15, 0, 0, 40, 15]);
  });

  it("1px distinto en el marco → esa fila frena", () => {
    // Píxel rojo en (20,2): las filas 0-1 ceden, la 2 se conserva (sy=2).
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const i = (2 * w + 20) * 4;
    datos[i] = 200;
    datos[i + 1] = 0;
    datos[i + 2] = 0;
    for (let y = 5; y <= 24; y += 1) {
      for (let x = 5; x <= 34; x += 1) {
        const j = (y * w + x) * 4;
        datos[j] = 128;
        datos[j + 1] = 128;
        datos[j + 2] = 128;
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
    expect(out.width).toBe(30);
    expect(out.height).toBe(23);
    expect(dibujos[0]?.slice(1)).toEqual([5, 2, 30, 23, 0, 0, 30, 23]);
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

  it("fondo a borde → nada que recortar", () => {
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

  it("tinta gris en impares → bbox exacto (regresión paso 1)", () => {
    // L en x=11/y=7 impares con tinta gris (el negro puro es fondo):
    // el scan por píxel no salta filas ni columnas con tinta.
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const tinta = (x: number, y: number): void => {
      const i = (y * w + x) * 4;
      datos[i] = 128;
      datos[i + 1] = 128;
      datos[i + 2] = 128;
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
