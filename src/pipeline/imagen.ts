/* Normalización de imágenes de entrada — JPEG único, EXIF derecha, tope 2000px.
   Toda imagen aceptada (jpeg/png/webp/bmp/gif) sale como JPEG CALIDAD_JPEG:
   una sola generación lossy; el exportador embebe el blob sin reconvertir. */

/** Lado mayor máximo tras normalizar (más píxeles no ayudan al OCR). */
export const LADO_MAX_IMAGEN: number = 2000;

/** Calidad JPEG única del pipeline (intake, páginas PDF y miniaturas). */
export const CALIDAD_JPEG: number = 0.9;

/** Canal >250 = blanco; píxeles muestreados cada 4px. */
const BLANCO_UMBRAL = 250;
const BLANCO_MUESTRA = 4;
/** ≥99.5% blancos/transparentes → imagen vacía (se omite). */
const BLANCO_RATIO = 0.995;

/**
 * Imagen vacía: casi todo blanco o transparente (el PDF sin fondo se
 * compone sobre blanco). Sin píxeles legibles no se puede juzgar → se conserva.
 */
// ponytail: umbral fijo 250/99.5%; conteo por texto/OCR si hay falsos positivos en tickets ralos.
export function esPaginaBlanca(lienzo: HTMLCanvasElement): boolean {
  const ctx = lienzo.getContext("2d");
  if (!ctx || lienzo.width < 1 || lienzo.height < 1) return false;
  let datos: Uint8ClampedArray;
  try {
    datos = ctx.getImageData(0, 0, lienzo.width, lienzo.height).data;
  } catch {
    return false;
  }
  let blancos = 0;
  let total = 0;
  for (let i = 0; i + 3 < datos.length; i += 4 * BLANCO_MUESTRA) {
    total += 1;
    if ((datos[i + 3] ?? 0) < 128) {
      blancos += 1;
    } else if (
      (datos[i] ?? 0) > BLANCO_UMBRAL &&
      (datos[i + 1] ?? 0) > BLANCO_UMBRAL &&
      (datos[i + 2] ?? 0) > BLANCO_UMBRAL
    ) {
      blancos += 1;
    }
  }
  return total > 0 && blancos / total >= BLANCO_RATIO;
}

/** Decode inyectable (jsdom no implementa createImageBitmap). */
export type CargarBitmap = (f: Blob, opc?: ImageBitmapOptions) => Promise<ImageBitmap>;

/** Fábrica de lienzo inyectable (los tests usan un falso). */
export type CrearLienzo = () => HTMLCanvasElement;

const cargarReal: CargarBitmap = (f, opc) => createImageBitmap(f, opc);

/** Por qué se rechazó una imagen (para el aviso; el llamador mapea a texto). */
export type MotivoImagen = "blanca" | "ilegible";

/** Normaliza un File a JPEG: EXIF enderezada, tope de lado, sin blancas.
    Lanza Error(MotivoImagen) si es corrupta o vacía. */
// ponytail: se decodifica antes de medir; Chrome rechaza dimensiones absurdas
// con error (→ "ilegible", el lote sigue). Parser de headers pre-decode solo
// si aparece un caso real de bomba de descompresión.
export async function normalizarImagen(
  f: File,
  cargar: CargarBitmap = cargarReal,
  crear: CrearLienzo = () => document.createElement("canvas"),
): Promise<Blob> {
  let bmp: ImageBitmap | null = null;
  try {
    try {
      bmp = await cargar(f, { imageOrientation: "from-image" });
    } catch {
      throw new Error("ilegible");
    }
    const escala = Math.min(1, LADO_MAX_IMAGEN / Math.max(bmp.width, bmp.height));
    const lienzo = crear();
    lienzo.width = Math.max(1, Math.round(bmp.width * escala));
    lienzo.height = Math.max(1, Math.round(bmp.height * escala));
    const ctx = lienzo.getContext("2d");
    if (!ctx) throw new Error("ilegible");
    ctx.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    if (esPaginaBlanca(lienzo)) throw new Error("blanca");
    const blob = await new Promise<Blob | null>((res) =>
      lienzo.toBlob(res, "image/jpeg", CALIDAD_JPEG),
    );
    if (!blob) throw new Error("ilegible");
    return blob;
  } finally {
    bmp?.close();
  }
}
