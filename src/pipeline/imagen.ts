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

export const cargarReal: CargarBitmap = (f, opc) => createImageBitmap(f, opc);

/** Fábrica real de lienzo (compartida con docaligner para no duplicarla). */
export const crearReal: CrearLienzo = () => document.createElement("canvas");

/** Canal <245 = tinta (250 es blanco hoja; 245 tolera JPEG/sombra mesa). */
const TINTA_UMBRAL = 245;
/** Paso de muestreo en el scan de bordes (O(n/4), basta a 720px). */
const PASO_BORDE = 2;
/** Margen de seguridad alrededor del bbox (no rozar texto al borde). */
const MARGEN_RECORTE = 8;
/** Bbox <15% del área → no recortar (ticket ralo, evita colapso). */
const AREA_MINIMA = 0.15;

/**
 * Recorta franjas blancas laterales (hoja PDF alrededor de la foto).
 * La sombra de la mesa cuenta como tinta, así que el bbox conserva la
 * foto + sombra y el ticket blanco interior no se agujerea.
 */
// ponytail: bbox por luminancia, no Canny; guarda 15% si ticket ralo.
export function recortarMargenesBlancos(
  src: HTMLCanvasElement,
  crear: CrearLienzo = crearReal,
): HTMLCanvasElement {
  const ancho = src.width;
  const alto = src.height;
  if (ancho < 1 || alto < 1) return src;
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  let datos: Uint8ClampedArray;
  try {
    datos = ctx.getImageData(0, 0, ancho, alto).data;
  } catch {
    return src;
  }
  const esTinta = (idx: number): boolean => {
    if ((datos[idx + 3] ?? 0) < 128) return false;
    return (
      (datos[idx] ?? 255) < TINTA_UMBRAL ||
      (datos[idx + 1] ?? 255) < TINTA_UMBRAL ||
      (datos[idx + 2] ?? 255) < TINTA_UMBRAL
    );
  };
  const filaTinta = (y: number): boolean => {
    const base = y * ancho;
    for (let x = 0; x < ancho; x += PASO_BORDE) {
      if (esTinta((base + x) * 4)) return true;
    }
    return false;
  };
  const colTinta = (x: number): boolean => {
    for (let y = 0; y < alto; y += PASO_BORDE) {
      if (esTinta((y * ancho + x) * 4)) return true;
    }
    return false;
  };
  let x0 = 0;
  let y0 = 0;
  let x1 = ancho - 1;
  let y1 = alto - 1;
  while (y0 < y1 && !filaTinta(y0)) y0 += 1;
  while (y1 > y0 && !filaTinta(y1)) y1 -= 1;
  while (x0 < x1 && !colTinta(x0)) x0 += 1;
  while (x1 > x0 && !colTinta(x1)) x1 -= 1;
  if (!filaTinta(y0) && !colTinta(x0)) return src;
  const sx = Math.max(0, x0 - MARGEN_RECORTE);
  const sy = Math.max(0, y0 - MARGEN_RECORTE);
  const ex = Math.min(ancho - 1, x1 + MARGEN_RECORTE);
  const ey = Math.min(alto - 1, y1 + MARGEN_RECORTE);
  const w = ex - sx + 1;
  const h = ey - sy + 1;
  if (w * h < ancho * alto * AREA_MINIMA) return src;
  if (w >= ancho && h >= alto) return src;
  const out = crear();
  out.width = Math.max(1, w);
  out.height = Math.max(1, h);
  const octx = out.getContext("2d");
  if (!octx) return src;
  try {
    octx.drawImage(src, sx, sy, w, h, 0, 0, w, h);
  } catch {
    return src;
  }
  return out;
}

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
  crear: CrearLienzo = crearReal,
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
