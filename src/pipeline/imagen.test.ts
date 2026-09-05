/* Tests: imagen — normalización JPEG única, tope 2000px, filtro blancas/corruptas. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CALIDAD_JPEG, LADO_MAX_IMAGEN, normalizarImagen } from "./imagen";
import type { CargarBitmap } from "./imagen";

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
