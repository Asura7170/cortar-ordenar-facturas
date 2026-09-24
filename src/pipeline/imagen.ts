/* Normalización de imágenes de entrada — WebP único, EXIF derecha, tope 2000px.
   Toda imagen aceptada que haya que corregir sale como WebP CALIDAD_WEBP;
   si ya es jpg/png/webp y no hay nada que corregir, pasa el original intacto
   (0 generaciones). El exportador convierte a JPEG al embeber en el docx. */

/** Lado mayor máximo tras normalizar (más píxeles no ayudan al OCR). */
export const LADO_MAX_IMAGEN: number = 2000;

/** Calidad JPEG única (conversión de salida a Word). */
export const CALIDAD_JPEG: number = 0.9;

/** Calidad WebP del pipeline (intake, warp, giros, recortes, páginas PDF). */
export const CALIDAD_WEBP: number = 0.85;

/** Formatos que pasan crudos si no hay nada que corregir (sin recompresión). */
const TIPOS_DIRECTOS: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** true si el blob ya es jpg/png/webp (por MIME o firma mágica si el type viene vacío). */
export async function esFormatoDirecto(f: Blob): Promise<boolean> {
  const t = (f.type ?? "").toLowerCase().trim();
  if (t !== "") return TIPOS_DIRECTOS.has(t);
  // ponytail: type vacío (algunos Android): firma de 12 bytes, sin decode.
  let head: Uint8Array;
  try {
    head = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  } catch {
    return false;
  }
  if (head.length < 4) return false;
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png =
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a;
  const webp =
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50;
  return jpeg || png || webp;
}

/** Canal >245 = blanco (antes 250: el gris app #f7f8fa también vacía); píxeles muestreados cada 4px. */
const BLANCO_UMBRAL = 245;
const BLANCO_MUESTRA = 4;
/** ≥99.5% blancos/transparentes → imagen vacía (se omite). */
const BLANCO_RATIO = 0.995;

/**
 * Imagen vacía: casi todo blanco o transparente (el PDF sin fondo se
 * compone sobre blanco). Sin píxeles legibles no se puede juzgar → se conserva.
 */
// ponytail: umbral fijo 245/99.5%; conteo por texto/OCR si hay falsos positivos en tickets ralos.
export function esPaginaBlanca(lienzo: HTMLCanvasElement): boolean {
  const ctx = ctxLectura(lienzo);
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
  const ctx = ctxLectura(lienzo);
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

/** Contexto 2D para lienzos que se leen (el atributo evita stalls GPU→CPU en readbacks). */
function ctxLectura(lienzo: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return lienzo.getContext("2d", { willReadFrequently: true }) ?? lienzo.getContext("2d");
}

/** Distancia máxima por canal al color del borde (medido: fila digital ≤6). */
const TOL_LADO = 15;
/** Margen alrededor del bbox (0: recorte exacto, sin franja blanca). */
const MARGEN_RECORTE = 0;
/** Bbox <15% del área → no recortar (ticket ralo, evita colapso). */
const AREA_MINIMA = 0.15;

/**
 * Recorta franjas uniformes por lado, del color que sea (cada lado con el suyo).
 * La sombra de la mesa no es uniforme: frena como antes y el bbox conserva la
 * foto + sombra; el ticket interior no se agujerea (su color ≠ borde).
 */
// ponytail: refs por mediana de borde, no paleta ni Canny; guarda 15% si ticket ralo.
export function recortarMargenesBlancos(
  src: HTMLCanvasElement,
  crear: CrearLienzo = crearReal,
): HTMLCanvasElement {
  const ancho = src.width;
  const alto = src.height;
  if (ancho < 1 || alto < 1) return src;
  const ctx = ctxLectura(src);
  if (!ctx) return src;
  let datos: Uint8ClampedArray;
  try {
    datos = ctx.getImageData(0, 0, ancho, alto).data;
  } catch {
    return src;
  }
  type RGB = readonly [number, number, number];
  const px = (x: number, y: number): number => (y * ancho + x) * 4;
  /** Mediana por canal del borde (robusta a motas 1px; ignora transparentes). */
  const medianaBorde = (toma: (k: number) => number, n: number): RGB => {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const i = toma(k);
      if ((datos[i + 3] ?? 0) < 128) continue;
      rs.push(datos[i] ?? 0);
      gs.push(datos[i + 1] ?? 0);
      bs.push(datos[i + 2] ?? 0);
    }
    const med = (v: number[]): number => {
      if (v.length === 0) return 0;
      const o = [...v].sort((a, b) => a - b);
      return o[Math.floor(o.length / 2)] ?? 0;
    };
    return [med(rs), med(gs), med(bs)];
  };
  const iguala = (i: number, ref: RGB): boolean =>
    (datos[i + 3] ?? 0) < 128 ||
    (Math.abs((datos[i] ?? 0) - ref[0]) <= TOL_LADO &&
      Math.abs((datos[i + 1] ?? 0) - ref[1]) <= TOL_LADO &&
      Math.abs((datos[i + 2] ?? 0) - ref[2]) <= TOL_LADO);
  const refArriba = medianaBorde((x) => px(x, 0), ancho);
  const refAbajo = medianaBorde((x) => px(x, alto - 1), ancho);
  const refIzq = medianaBorde((y) => px(0, y), alto);
  const refDer = medianaBorde((y) => px(ancho - 1, y), alto);
  // Fila recortable: franjas laterales del color de su lado + centro del de arriba/abajo
  // (cada lado puede traer su propio color sin bloquear al vecino).
  const filaFondo = (y: number, ref: RGB): boolean => {
    let a = 0;
    while (a < ancho && iguala(px(a, y), refIzq)) a += 1;
    let b = ancho - 1;
    while (b >= a && iguala(px(b, y), refDer)) b -= 1;
    for (let x = a; x <= b; x += 1) {
      if (!iguala(px(x, y), ref)) return false;
    }
    return true;
  };
  const colFondo = (x: number, ref: RGB): boolean => {
    let a = 0;
    while (a < alto && iguala(px(x, a), refArriba)) a += 1;
    let b = alto - 1;
    while (b >= a && iguala(px(x, b), refAbajo)) b -= 1;
    for (let y = a; y <= b; y += 1) {
      if (!iguala(px(x, y), ref)) return false;
    }
    return true;
  };
  let x0 = 0;
  let y0 = 0;
  let x1 = ancho - 1;
  let y1 = alto - 1;
  while (y0 < y1 && filaFondo(y0, refArriba)) y0 += 1;
  while (y1 > y0 && filaFondo(y1, refAbajo)) y1 -= 1;
  while (x0 < x1 && colFondo(x0, refIzq)) x0 += 1;
  while (x1 > x0 && colFondo(x1, refDer)) x1 -= 1;
  if (filaFondo(y0, refArriba) && colFondo(x0, refIzq)) return src;
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

/** Normaliza un File: EXIF enderezada, tope de lado, recorte de fondo y sin vacías.
    Si ya es jpg/png/webp y no hay nada que corregir, devuelve el original intacto.
    Si hay que corregir, empaqueta la copia a WebP. Lanza Error(MotivoImagen) si
    es corrupta o vacía (negra incluida: mismo aviso). */
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
    const directo = await esFormatoDirecto(f);
    try {
      bmp = await cargar(f, { imageOrientation: "from-image" });
    } catch {
      throw new Error("ilegible");
    }
    const escala = Math.min(1, LADO_MAX_IMAGEN / Math.max(bmp.width, bmp.height));
    const lienzo = crear();
    lienzo.width = Math.max(1, Math.round(bmp.width * escala));
    lienzo.height = Math.max(1, Math.round(bmp.height * escala));
    const ctx = ctxLectura(lienzo);
    if (!ctx) throw new Error("ilegible");
    ctx.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
    // ponytail: mismo recorte que el PDF (el aire tuerce el quad de DocAligner).
    const recortado = recortarMargenesBlancos(lienzo, crear);
    if (esPaginaBlanca(recortado) || esPaginaNegra(recortado)) throw new Error("blanca");
    // ponytail: sin nada que corregir el original pasa intacto (0 generaciones);
    // si no, la copia ya corregida se empaqueta a WebP (más liviano que PNG).
    if (directo && escala === 1 && recortado === lienzo) return f;
    const blob = await new Promise<Blob | null>((res) =>
      recortado.toBlob(res, "image/webp", CALIDAD_WEBP),
    );
    if (!blob) throw new Error("ilegible");
    return blob;
  } finally {
    bmp?.close();
  }
}
