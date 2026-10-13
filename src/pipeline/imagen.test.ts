/* Tests: imagen — normalización WebP/passthrough, tope 2000px, filtro blancas/corruptas. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CALIDAD_WEBP,
  LADO_MAX_IMAGEN,
  baja,
  bboxRecorte,
  esFondoBlanco,
  esFondoNegro,
  esFormatoDirecto,
  esJpeg,
  esPng,
  esWebp,
  iguala,
  medianaBorde,
  medianaCanal,
  normalizarImagen,
  recortarMargenesBlancos,
  recorteViable,
  sube,
  tramoFondo,
} from "./imagen";
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
      cb(new Blob(["x"], { type: t ?? "" }));
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
  it("bmp chico se empaqueta a webp 0.85", async () => {
    const falso = lienzoFalso(conTinta);
    const blob = await normalizarImagen(img("a.bmp", "image/bmp"), cargar(100, 80), falso.crear);
    expect(blob.type).toBe("image/webp"); // el falso hace eco del tipo pedido; lo que importa:
    expect(falso.tipo()).toBe("image/webp");
    expect(falso.calidad()).toBe(CALIDAD_WEBP);
    // Guard de regresión: sin from-image el EXIF no se endereza.
    expect(ultimaOpc).toEqual({ imageOrientation: "from-image" });
  });

  it("jpg chico sin nada que corregir pasa el original intacto (0 gens)", async () => {
    const falso = lienzoFalso(conTinta);
    const f = img("a.jpg", "image/jpeg");
    const blob = await normalizarImagen(f, cargar(100, 80), falso.crear);
    expect(blob).toBe(f);
    expect(falso.tipo()).toBeNull(); // ni siquiera se pidió empaquetar
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
      normalizarImagen(img("n.bmp", "image/bmp"), cargar(10, 10), () => lienzoNulo),
    ).rejects.toThrow("ilegible");
  });
});

describe("esFormatoDirecto", () => {
  it("mime jpg/png/webp pasa, bmp no", async () => {
    expect(await esFormatoDirecto(img("a.jpg", "image/jpeg"))).toBe(true);
    expect(await esFormatoDirecto(img("a.png", "image/png"))).toBe(true);
    expect(await esFormatoDirecto(img("a.webp", "image/webp"))).toBe(true);
    expect(await esFormatoDirecto(img("a.bmp", "image/bmp"))).toBe(false);
  });

  it("type vacío se olfatea por firma mágica", async () => {
    const sinTipo = (bytes: number[]): Blob => new Blob([new Uint8Array(bytes)]);
    expect(await esFormatoDirecto(sinTipo([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      true,
    );
    expect(
      await esFormatoDirecto(sinTipo([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    ).toBe(true);
    expect(
      await esFormatoDirecto(sinTipo([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe(true);
    expect(await esFormatoDirecto(sinTipo([0, 1, 2, 3]))).toBe(false);
  });

  it("slice que falla o head < 4 bytes → false sin lanzar", async () => {
    const roto = {
      slice: (): { arrayBuffer: () => Promise<never> } => ({
        arrayBuffer: () => Promise.reject(new Error("red")),
      }),
    } as unknown as Blob;
    expect(await esFormatoDirecto(roto)).toBe(false);
    expect(await esFormatoDirecto(new Blob([new Uint8Array([0xff, 0xd8])]))).toBe(false);
  });
});

describe("firmas mágicas (esJpeg/esPng/esWebp)", () => {
  const jpeg = [0xff, 0xd8, 0xff, 0xe0];
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const webp = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

  it("acepta su magia y rechaza la ajena", () => {
    expect(esJpeg(new Uint8Array(jpeg))).toBe(true);
    expect(esPng(new Uint8Array(png))).toBe(true);
    expect(esWebp(new Uint8Array(webp))).toBe(true);
    expect(esPng(new Uint8Array(jpeg))).toBe(false);
    expect(esWebp(new Uint8Array(png))).toBe(false);
    expect(esJpeg(new Uint8Array(webp))).toBe(false);
  });

  it("cada byte de la magia cuenta (1 cambiado por posición)", () => {
    for (let k = 0; k < 3; k += 1) {
      const roto = [...jpeg];
      roto[k] = jpeg[k] === 0xff ? 0xfe : 0xff;
      expect(esJpeg(new Uint8Array(roto))).toBe(false);
    }
    for (let k = 0; k < png.length; k += 1) {
      const roto = [...png];
      roto[k] = png[k] === 0x89 ? 0x88 : 0x89;
      expect(esPng(new Uint8Array(roto))).toBe(false);
    }
    for (const k of [0, 1, 2, 3, 8, 9, 10, 11]) {
      const roto = [...webp];
      roto[k] = webp[k] === 0x52 ? 0x53 : 0x52;
      expect(esWebp(new Uint8Array(roto))).toBe(false);
    }
  });

  it("truncado: lado corto → false sin lanzar", () => {
    expect(esPng(new Uint8Array(png.slice(0, 7)))).toBe(false);
    expect(esWebp(new Uint8Array(webp.slice(0, 11)))).toBe(false);
    expect(esPng(new Uint8Array(0))).toBe(false);
    expect(esWebp(new Uint8Array(0))).toBe(false);
    expect(esJpeg(new Uint8Array(0))).toBe(false);
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

  it("lados de distinto color no puro → recorta (cada lado con el suyo)", () => {
    // Izquierda morada, resto verde (ninguno es blanco/negro: la paleta fija
    // no recortaba esto): la esquina no bloquea al vecino.
    const { src, dibujos } = lienzoConMarco(
      (x) => (x < 5 ? [48, 0, 122] : [0, 100, 0]),
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

  it("frontera TOL: diff 15 cede, diff 16 frena", () => {
    // Filas a ancho completo sobre blanco 255 + bloque gris (x5-34/y22-24):
    // la fila 240 (diff 15) se come, la 239 (diff 16) frena (y0=20).
    const w = 40;
    const h = 30;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const fila = (y: number, v: number): void => {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        datos[i] = v;
        datos[i + 1] = v;
        datos[i + 2] = v;
      }
    };
    fila(10, 240);
    fila(20, 239);
    for (let y = 22; y <= 24; y += 1) {
      for (let x = 5; x <= 34; x += 1) {
        const i = (y * w + x) * 4;
        datos[i] = 128;
        datos[i + 1] = 128;
        datos[i + 2] = 128;
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
    expect(out.width).toBe(40);
    expect(out.height).toBe(5);
    expect(dibujos[0]?.slice(1)).toEqual([0, 20, 40, 5, 0, 0, 40, 5]);
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

describe("esFondoBlanco/esFondoNegro", () => {
  const pix = (...canales: number[]): Uint8ClampedArray => new Uint8ClampedArray(canales);

  it("blanco: transparencia o 3 canales sobre 245; gris medio no", () => {
    expect(esFondoBlanco(pix(255, 255, 255, 255), 0)).toBe(true);
    expect(esFondoBlanco(pix(0, 0, 0, 0), 0)).toBe(true); // alfa 0
    expect(esFondoBlanco(pix(0, 0, 0, 127), 0)).toBe(true); // alfa 127 cuenta fondo
    expect(esFondoBlanco(pix(250, 250, 250, 128), 0)).toBe(true); // alfa 128 + canales
    expect(esFondoBlanco(pix(255, 99, 99, 255), 0)).toBe(false); // un canal bajo
    expect(esFondoBlanco(pix(245, 245, 245, 255), 0)).toBe(false); // umbral es >
  });

  it("negro: transparencia o 3 canales bajo 20; el gris oscuro no", () => {
    expect(esFondoNegro(pix(0, 0, 0, 255), 0)).toBe(true);
    expect(esFondoNegro(pix(0, 0, 0, 0), 0)).toBe(true);
    expect(esFondoNegro(pix(0, 0, 0, 127), 0)).toBe(true);
    expect(esFondoNegro(pix(19, 19, 19, 128), 0)).toBe(true);
    expect(esFondoNegro(pix(20, 20, 20, 255), 0)).toBe(false); // 20 no entra (es <)
    expect(esFondoNegro(pix(0, 0, 99, 255), 0)).toBe(false);
  });
});

describe("medianaCanal/medianaBorde", () => {
  it("mediana: central del ordenado, vacío → 0", () => {
    expect(medianaCanal([3, 1, 2])).toBe(2);
    expect(medianaCanal([9, 1])).toBe(9); // par: central superior (comportamiento original)
    expect(medianaCanal([])).toBe(0);
  });

  it("medianaBorde salta transparentes y usa los índices de toma", () => {
    const datos = new Uint8ClampedArray([0, 0, 0, 0, 1, 2, 3, 255]);
    expect(medianaBorde(datos, (k) => k * 4, 2)).toEqual([1, 2, 3]);
    expect(medianaBorde(datos, () => 0, 4)).toEqual([0, 0, 0]); // todo transparente
  });
});

describe("iguala", () => {
  it("match a TOL (diff 15) y fuera por 1 canal (diff 16)", () => {
    const datos = new Uint8ClampedArray([254, 254, 254, 255]);
    expect(iguala(datos, 0, [239, 239, 239])).toBe(true);
    expect(iguala(datos, 0, [238, 239, 239])).toBe(false);
    expect(iguala(datos, 0, [10, 10, 10])).toBe(false);
  });

  it("transparencia es fondo sin mirar canales", () => {
    const alfa = new Uint8ClampedArray([0, 0, 0, 100]);
    expect(iguala(alfa, 0, [255, 255, 255])).toBe(true);
  });
});

describe("tramoFondo", () => {
  it("todo fondo → tramo completo; intruso al centro → null", () => {
    const datos = new Uint8ClampedArray(3 * 4).fill(255);
    const toma = (k: number): number => k * 4;
    const blanco: readonly [number, number, number] = [255, 255, 255];
    // Fila toda-fondo: el scan izquierdo termina en `largo` y el derecho queda corto
    // ([largo, largo-1] degenerado, como el original con rango interior vacío).
    expect(tramoFondo(datos, 3, toma, blanco, blanco, blanco)).toEqual([3, 2]);
    datos[2 * 4] = 128; // gris en la posición central
    expect(tramoFondo(datos, 3, toma, blanco, blanco, blanco)).toBeNull();
  });
});

describe("sube/baja", () => {
  it("avanzan/retroceden cortando en la tinta", () => {
    expect(sube(0, 5, (k) => k < 3)).toBe(3);
    expect(sube(0, 5, () => true)).toBe(5);
    expect(baja(5, 0, (k) => k > 3)).toBe(3);
  });
});

describe("bboxRecorte/recorteViable", () => {
  const blanco: readonly [number, number, number] = [255, 255, 255];

  it("encoge al contenido y da null si todo es uniforme", () => {
    const w = 4;
    const h = 3;
    const datos = new Uint8ClampedArray(w * h * 4).fill(255);
    const i = (1 * w + 2) * 4;
    datos[i] = 128;
    datos[i + 1] = 128;
    datos[i + 2] = 128;
    expect(bboxRecorte(datos, w, h, blanco, blanco, blanco, blanco)).toEqual({
      x0: 2,
      y0: 1,
      x1: 2,
      y1: 1,
    });
    expect(
      bboxRecorte(new Uint8ClampedArray(w * h * 4).fill(255), w, h, blanco, blanco, blanco, blanco),
    ).toBeNull();
  });

  it("recorteViable: tamaño completo o área < 15% colapsan", () => {
    expect(recorteViable(10, 10, 10, 10)).toBe(false);
    expect(recorteViable(3, 3, 10, 10)).toBe(false);
    expect(recorteViable(4, 4, 10, 10)).toBe(true);
  });
});
