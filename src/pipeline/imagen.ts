/* Normalización de imágenes de entrada — JPEG único, EXIF derecha, tope 2000px.
   Toda imagen aceptada (jpeg/png/webp/bmp/gif) sale como JPEG CALIDAD_JPEG:
   una sola generación lossy; el exportador embebe el blob sin reconvertir. */

/** Lado mayor máximo tras normalizar (más píxeles no ayudan al OCR). */
export const LADO_MAX_IMAGEN: number = 2000;

/** Calidad JPEG única del pipeline (intake, páginas PDF y miniaturas). */
export const CALIDAD_JPEG: number = 0.9;

/** Canal >245 = blanco (antes 250: el gris app #f7f8fa también vacía); píxeles muestreados cada 4px. */
const BLANCO_UMBRAL = 245;
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

/** Canal <20 = negro (tolera ruido JPEG/foto de página oscura). */
const NEGRO_UMBRAL = 20;
/** ≥99.5% negros/transparentes → imagen vacía, igual que blanca (se omite). */
const NEGRO_RATIO = 0.995;

/**
 * Imagen oscura: casi todo negro o transparente. Espejo de esPaginaBlanca
 * para comprobantes bancarios con fondo negro (el motivo thrown se reutiliza:
 * el llamador no distingue el string, solo avisa "no se pudo leer").
 */
// ponytail: espejo de esPaginaBlanca, no abstracción; el umbral vive aquí, no en config.
export function esPaginaNegra(lienzo: HTMLCanvasElement): boolean {
  const ctx = lienzo.getContext("2d");
  if (!ctx || lienzo.width < 1 || lienzo.height < 1) return false;
  let datos: Uint8ClampedArray;
  try {
    datos = ctx.getImageData(0, 0, lienzo.width, lienzo.height).data;
  } catch {
    return false;
  }
  let negros = 0;
  let total = 0;
  for (let i = 0; i + 3 < datos.length; i += 4 * BLANCO_MUESTRA) {
    total += 1;
    if ((datos[i + 3] ?? 0) < 128) {
      negros += 1;
    } else if (
      (datos[i] ?? 255) < NEGRO_UMBRAL &&
      (datos[i + 1] ?? 255) < NEGRO_UMBRAL &&
      (datos[i + 2] ?? 255) < NEGRO_UMBRAL
    ) {
      negros += 1;
    }
  }
  return total > 0 && negros / total >= NEGRO_RATIO;
}

/** Decode inyectable (jsdom no implementa createImageBitmap). */
export type CargarBitmap = (f: Blob, opc?: ImageBitmapOptions) => Promise<ImageBitmap>;

/** Fábrica de lienzo inyectable (los tests usan un falso). */
export type CrearLienzo = () => HTMLCanvasElement;

export const cargarReal: CargarBitmap = (f, opc) => createImageBitmap(f, opc);

/** Fábrica real de lienzo (compartida con docaligner para no duplicarla). */
export const crearReal: CrearLienzo = () => document.createElement("canvas");

/** Salto entre píxeles vecinos que marca contenido (medido BancoSol: ruido JPEG y marca de agua ≤~25; etiquetas grises ~125, texto y bordes muy por encima). */
const TOL_FONDO = 40;
/** Brillo medio mínimo del tramo central para recortar (blanco/gris papel sí; tinta y marcos oscuros no: la foto sobre mesa se conserva). */
const LUZ_MEDIA = 180;
/** Ancho mínimo del tramo central (un píxel suelto —motas, un trazo— no es aire). */
const ANCHO_MIN_MEDIO = 4;
/** Ancho máximo de racha perdonable en bordes (artefacto JPEG/AA de 1-2px). */
const RUIDO_MAX_ANCHO = 2;
/** Salto máximo perdonable (tenue: tinta y bordes reales lo superan). */
const RUIDO_MAX_SALTO = 120;
/** Paso del scan de bordes (1: exacto; sub-ms a 720px, muy lejos de los ~250ms de ORT). */
const PASO_BORDE = 1;
/** Margen alrededor del bbox (0: recorte exacto, sin franja blanca). */
const MARGEN_RECORTE = 0;
/** Bbox <15% del área → no recortar (ticket ralo, evita colapso). */
const AREA_MINIMA = 0.15;

/**
 * Recorta franjas de fondo por lado (blanco, gris app, color bancario o negro).
 * El fondo se sigue en degradado desde ambos bordes; el tramo central debe ser
 * liso y claro: así ceden marcos bitono y aire con marca de agua, y frenan la
 * tinta interior, el texto claro sobre cabecera y la foto sobre mesa clara.
 */
// ponytail: una pasada por línea (bordes + medio); sin paleta ni Canny; guarda 15% si ticket ralo.
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
  const salto = (i: number, ref: number): number =>
    Math.max(
      Math.abs((datos[i] ?? 0) - (datos[ref] ?? 0)),
      Math.abs((datos[i + 1] ?? 0) - (datos[ref + 1] ?? 0)),
      Math.abs((datos[i + 2] ?? 0) - (datos[ref + 2] ?? 0)),
    );
  const difiere = (i: number, ref: number): boolean => salto(i, ref) > TOL_FONDO;
  /** Línea de fondo: tramos lisos en ambos bordes + tramo central liso y claro. */
  const lineaFondo = (eje: 0 | 1, fijo: number, n: number): boolean => {
    const toma = (k: number): number => {
      const i = (eje === 0 ? fijo * ancho + k : k * ancho + fijo) * 4;
      return (datos[i + 3] ?? 0) < 128 ? -1 : i; // transparente = fondo
    };
    let a = 0;
    let ref = -1;
    let saltos = 0;
    for (; a < n; a += PASO_BORDE) {
      const i = toma(a);
      if (i < 0) continue;
      if (ref >= 0 && difiere(i, ref)) {
        // ponytail: se perdona el ruido angosto y tenue de borde (artefacto
        // JPEG Δ44-50 medido en BancoSol); la tinta agota el presupuesto.
        if (saltos >= RUIDO_MAX_ANCHO || salto(i, ref) >= RUIDO_MAX_SALTO) break;
        saltos += 1;
        continue;
      }
      ref = i;
      saltos = 0;
    }
    let b = n - 1;
    ref = -1;
    saltos = 0;
    for (; b >= a; b -= PASO_BORDE) {
      const i = toma(b);
      if (i < 0) continue;
      if (ref >= 0 && difiere(i, ref)) {
        if (saltos >= RUIDO_MAX_ANCHO || salto(i, ref) >= RUIDO_MAX_SALTO) break;
        saltos += 1;
        continue;
      }
      ref = i;
      saltos = 0;
    }
    let suma = 0;
    let cuenta = 0;
    ref = -1;
    if (a <= b && b - a + 1 < ANCHO_MIN_MEDIO) return false;
    for (let k = a; k <= b; k += PASO_BORDE) {
      const i = toma(k);
      if (i < 0) continue;
      if (ref >= 0 && difiere(i, ref)) return false;
      ref = i;
      suma += (datos[i] ?? 0) + (datos[i + 1] ?? 0) + (datos[i + 2] ?? 0);
      cuenta += 1;
    }
    return cuenta === 0 || suma / (cuenta * 3) >= LUZ_MEDIA;
  };
  const filaFondo = (y: number): boolean => lineaFondo(0, y, ancho);
  const colFondo = (x: number): boolean => lineaFondo(1, x, alto);
  let x0 = 0;
  let y0 = 0;
  let x1 = ancho - 1;
  let y1 = alto - 1;
  while (y0 < y1 && filaFondo(y0)) y0 += 1;
  while (y1 > y0 && filaFondo(y1)) y1 -= 1;
  while (x0 < x1 && colFondo(x0)) x0 += 1;
  while (x1 > x0 && colFondo(x1)) x1 -= 1;
  if (filaFondo(y0) && colFondo(x0)) return src;
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

/** Normaliza un File a JPEG: EXIF enderezada, tope de lado, recorte de fondo y sin vacías.
    Lanza Error(MotivoImagen) si es corrupta o vacía (negra incluida: mismo aviso). */
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
    // ponytail: mismo recorte que el PDF (el aire tuerce el quad de DocAligner).
    const recortado = recortarMargenesBlancos(lienzo, crear);
    if (esPaginaBlanca(recortado) || esPaginaNegra(recortado)) throw new Error("blanca");
    const blob = await new Promise<Blob | null>((res) =>
      recortado.toBlob(res, "image/jpeg", CALIDAD_JPEG),
    );
    if (!blob) throw new Error("ilegible");
    return blob;
  } finally {
    bmp?.close();
  }
}
