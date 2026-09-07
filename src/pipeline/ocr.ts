/* OCR PP-OCRv6_small: detección de líneas + reconocimiento con onnxruntime-web.
   Sin dependencias nuevas: modelos en public/models/ocr, pre/post-proceso en
   ocrDb.ts/ocrRec.ts. Entrada: blob ya recortado por DocAligner; salida:
   texto plano por líneas ("" si no hay texto o algo falla: la cola sigue). */
import { TIMEOUT_EP_MS, iniciarSesion } from "./docaligner";
import { DICT_OCR } from "./ocrDict";
import { cajasDesdeMapa } from "./ocrDb";
import type { CajaDb } from "./ocrDb";
import {
  apilarLineas,
  decodificarCtc,
  matrizAfin,
  matrizInversa,
  normalizarLinea,
  REC_ALTO,
} from "./ocrRec";
import type { LineaNorm, TextoRec } from "./ocrRec";
import { CALIDAD_JPEG, cargarReal, crearReal } from "./imagen";
import type { CargarBitmap, CrearLienzo } from "./imagen";

const RUTA_DET = `${import.meta.env.BASE_URL}models/ocr/det.onnx`;
const RUTA_REC = `${import.meta.env.BASE_URL}models/ocr/rec.onnx`;
/**
 * Lado mayor de entrada al det (960/max como el default "general" del SDK
 * oficial; el eval de entrenamiento usa 736/min pero eso reescala hacia
 * arriba los recortes de 720px sin ganar nada).
 */
const LADO_DET_MAX: number = 960;
/** Normalización ImageNet del det (NormalizeImage del det.yml). */
const DET_MEDIA: readonly number[] = [0.485, 0.456, 0.406];
const DET_STD: readonly number[] = [0.229, 0.224, 0.225];
/** Múltiplo exigido por la red (resize_image_type0 de PaddleOCR). */
const DET_MULTIPLO = 32;
/** Lado mínimo tras el resize (las cajas no existen bajo esto). */
const DET_LADO_MIN = 8;

/** Salida mínima de sesión (ort.Tensor la satisface con cast en el borde). */
export interface SalidaOcr {
  readonly data: ArrayLike<number>;
  readonly dims: ReadonlyArray<number | string>;
}

/** Subsesión (det o rec): crear tensores + ejecutar. */
export interface SubsesionOcr {
  tensor(datos: Float32Array, formas: readonly number[]): unknown;
  run(feeds: Record<string, unknown>): Promise<Record<string, SalidaOcr>>;
}

/** Núcleo OCR: ambas sesiones listas. */
export interface NucleoOcr {
  readonly det: SubsesionOcr;
  readonly rec: SubsesionOcr;
}

/** Deps inyectables (por defecto: reales; los tests las stubban, sin onnx). */
export interface DepsOcr {
  readonly cargar?: CargarBitmap;
  readonly crear?: CrearLienzo;
  readonly nucleo?: () => Promise<NucleoOcr>;
}

type OrtModulo = typeof import("onnxruntime-web/webgpu");

/** Descarga un modelo con el mismo presupuesto que un intento de EP. */
async function descargarModelo(ruta: string): Promise<ArrayBuffer> {
  const res = await fetch(ruta, { signal: AbortSignal.timeout(TIMEOUT_EP_MS) });
  if (!res.ok) throw new Error(`modelo OCR: HTTP ${res.status} en ${ruta}`);
  return res.arrayBuffer();
}

/** Envuelve una sesión ort real en la interfaz mínima (casts solo aquí). */
export function envolver(
  ort: OrtModulo,
  sesion: import("onnxruntime-web").InferenceSession,
  nombre: string,
): SubsesionOcr {
  if (nombre === "rec") {
    // ponytail: ValueMetadata de ort-web 1.29 expone shape (nunca dimensions).
    const meta = sesion.outputMetadata[0];
    const forma = meta && meta.isTensor ? meta.shape : undefined;
    const clases = forma?.[forma.length - 1];
    // ponytail: fallo fuerte en init si el modelo no casa con el dict (no basura silenciosa).
    if (typeof clases === "number" && clases !== DICT_OCR.length) {
      throw new Error(`rec con ${clases} clases, dict con ${DICT_OCR.length}`);
    }
  }
  return {
    tensor: (datos, formas) => new ort.Tensor("float32", datos, [...formas]),
    run: (feeds) =>
      sesion.run(feeds as Record<string, never>) as unknown as Promise<Record<string, SalidaOcr>>,
  };
}

/** Núcleo real: importa ort (dinámico: onnx solo baja con el primer uso), EPs webgpu→wasm. */
async function nucleoReal(): Promise<NucleoOcr> {
  // ponytail: mismos valores que docaligner (single-thread: COEP bloquea pthreads).
  const ort: OrtModulo = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
  ort.env.wasm.numThreads = 1;
  const crearSesion =
    (pesos: ArrayBuffer) =>
    async (ep: string): Promise<import("onnxruntime-web").InferenceSession> =>
      ort.InferenceSession.create(pesos, {
        executionProviders: [ep],
        graphOptimizationLevel: "all",
      });
  // ponytail: las bajadas en paralelo (la mitad del tiempo); las sesiones en
  // serie (compiten por el mismo contexto GPU). El latch de EPs caídos sigue
  // compartido con docaligner: si webgpu murió ahí, aquí ni se intenta.
  const [detBuf, recBuf] = await Promise.all([
    descargarModelo(RUTA_DET),
    descargarModelo(RUTA_REC),
  ]);
  const det = envolver(ort, await iniciarSesion(crearSesion(detBuf)), "det");
  const rec = envolver(ort, await iniciarSesion(crearSesion(recBuf)), "rec");
  return { det, rec };
}

let nucleoEnCurso: Promise<NucleoOcr> | null = null;

/** Singleton lazy del núcleo (falla y el siguiente comprobante reintenta). */
export function obtenerNucleo(): Promise<NucleoOcr> {
  if (!nucleoEnCurso) {
    nucleoEnCurso = nucleoReal().catch((e: unknown) => {
      nucleoEnCurso = null;
      throw e;
    });
  }
  return nucleoEnCurso;
}

/**
 * Lado mayor→máx con múltiplo de 32 (resize_image_type0 de PaddleOCR).
 * Reduce lo grande; lo menor al múltiplo sube a 32 (mínimo de la red).
 */
export function tamanoDet(
  w: number,
  h: number,
  max: number = LADO_DET_MAX,
): { w: number; h: number } {
  if (w < 1 || h < 1) return { w: 0, h: 0 };
  const ratio = Math.max(w, h) > max ? max / Math.max(w, h) : 1;
  const mult = (v: number): number =>
    Math.max(DET_MULTIPLO, Math.round((v * ratio) / DET_MULTIPLO) * DET_MULTIPLO);
  return { w: mult(w), h: mult(h) };
}

/** RGBA de canvas → BGR plano (det y rec comen BGR). */
export function bgrDesdeRgba(rgba: Uint8ClampedArray): Uint8Array {
  const n = Math.floor(rgba.length / 4);
  const bgr = new Uint8Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    bgr[i * 3] = rgba[i * 4 + 2] ?? 0;
    bgr[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
    bgr[i * 3 + 2] = rgba[i * 4] ?? 0;
  }
  return bgr;
}

/** Tensor CHW [3,H,W] normalizado ImageNet desde BGR plano. */
export function tensorDet(bgr: Uint8Array, w: number, h: number): Float32Array {
  const t = new Float32Array(3 * w * h);
  const plano = w * h;
  for (let i = 0; i < plano; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      t[c * plano + i] = ((bgr[i * 3 + c] ?? 0) / 255 - (DET_MEDIA[c] ?? 0)) / (DET_STD[c] ?? 1);
    }
  }
  return t;
}

/** RGBA de canvas → tensor CHW normalizado en una pasada (sin alloc BGR intermedia). */
export function tensorDetDesdeRgba(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const plano = w * h;
  const t = new Float32Array(3 * plano);
  for (let i = 0; i < plano; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      // ponytail: canal c del BGR = byte 2−c del RGBA; mismos guards que la vía en 2 pasos.
      t[c * plano + i] =
        ((rgba[i * 4 + (2 - c)] ?? 0) / 255 - (DET_MEDIA[c] ?? 0)) / (DET_STD[c] ?? 1);
    }
  }
  return t;
}

/** Diagnóstico del rec (P1: telemetría para decidir la mitigación). */
export interface DiagRec {
  cajas: number;
  lote: number;
  anchoMax: number;
  fallback: boolean;
  recRuns: number;
}

/** DiagRec en ceros (el llamador lo crea; las funciones lo rellenan). */
export function diagVacio(): DiagRec {
  return { cajas: 0, lote: 0, anchoMax: 0, fallback: false, recRuns: 0 };
}

/** Nombre del tensor de salida en ambos onnx (fetch_name_0). */
const SALIDA_ONNX = "fetch_name_0";

/** Giros candidatos (0 = tal cual). El orden es el fast-path: derecha, costados, revés. */
export type Giro = 0 | 90 | 180 | 270;
/** Masa mínima del mapa para intentar giros (bajo esto no hay texto). */
export const UMBRAL_MAPA_VACIO: number = 0.0005;
/* Calibración Chrome (iriarte de costado; conf rec top-2 por giro):
   0° costado 0.24, 90° cabeza 0.61, 270° derecho 0.99, 180° costado 0.26.
   OK acepta al instante el pico; sin OK gana el más alto (sin suelo). */
export const UMBRAL_REC_OK: number = 0.9;
/** Cajas por orientación que puntúa el rec (más es más recs, no más señal). */
export const TOP_CAJAS_GIRO = 2;
/** Orden de prueba: lo común primero (bypass inmediato), el revés al final. */
const GIROS_PRUEBA: readonly Giro[] = [0, 90, 270, 180];

/** Imagen enderezada + material del giro ganador (el OCR real reutiliza cajas/base). */
export interface Enderezado {
  readonly blob: Blob;
  readonly grados: Giro;
  readonly cajas: CajaDb[];
  readonly base: HTMLCanvasElement | null;
}

/** Mapa de probabilidad del det sobre un lienzo ya a tamaño det. Null sin salida válida. */
async function pasarDet(
  det: SubsesionOcr,
  base: HTMLCanvasElement,
): Promise<{ mapa: Float32Array; mw: number; mh: number } | null> {
  const ctx = base.getContext("2d");
  if (!ctx) return null;
  const datos = ctx.getImageData(0, 0, base.width, base.height).data;
  const sal = await det.run({
    x: det.tensor(tensorDetDesdeRgba(datos, base.width, base.height), [
      1,
      3,
      base.height,
      base.width,
    ]),
  });
  const mapa = datosSalida(sal[SALIDA_ONNX]);
  const dims = sal[SALIDA_ONNX]?.dims;
  const mh = Number(dims?.[2] ?? 0);
  const mw = Number(dims?.[3] ?? 0);
  if (!mapa || !Number.isInteger(mh) || !Number.isInteger(mw) || mh < 1 || mw < 1) return null;
  return { mapa, mw, mh };
}

/** Media del mapa (presencia de texto); 0 si vacío. */
function masaMapa(mapa: Float32Array): number {
  if (mapa.length === 0) return 0;
  let suma = 0;
  for (let i = 0; i < mapa.length; i += 1) suma += mapa[i] ?? 0;
  return suma / mapa.length;
}

/** Bitmap rotado en un lienzo (setTransform directo: testeable sin DOM). Null sin contexto. */
function lienzoGirado(
  bmp: ImageBitmap,
  grados: Giro,
  crear: CrearLienzo,
): HTMLCanvasElement | null {
  const vertical = grados === 90 || grados === 270;
  const lienzo = crear();
  lienzo.width = vertical ? bmp.height : bmp.width;
  lienzo.height = vertical ? bmp.width : bmp.height;
  const ctx = lienzo.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const w = lienzo.width;
  const h = lienzo.height;
  if (grados === 180) ctx.setTransform(-1, 0, 0, -1, w, h);
  else if (grados === 90) ctx.setTransform(0, 1, -1, 0, w, 0);
  else if (grados === 270) ctx.setTransform(0, -1, 1, 0, 0, h);
  try {
    ctx.drawImage(bmp, 0, 0);
  } catch {
    return null;
  }
  return lienzo;
}

/** Lienzo → JPEG (misma calidad que el intake). Null si no codifica. */
function blobDeLienzo(lienzo: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((res) => {
    try {
      lienzo.toBlob((b) => res(b), "image/jpeg", CALIDAD_JPEG);
    } catch {
      res(null);
    }
  });
}

/**
 * Endereza por confianza del REC (el det solo recorta líneas, no vota):
 * primera orientación con conf ≥ OK gana al instante (bypass); si ninguna
 * llega, gana la más alta. Nunca lanza.
 */
export async function enderezar(blob: Blob, deps?: DepsOcr): Promise<Enderezado> {
  const quieto: Enderezado = { blob, grados: 0, cajas: [], base: null };
  const cargar = deps?.cargar ?? cargarReal;
  const crear = deps?.crear ?? crearReal;
  const fabrica = deps?.nucleo ?? obtenerNucleo;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await cargar(blob, { imageOrientation: "from-image" });
    if (bmp.width < DET_LADO_MIN || bmp.height < DET_LADO_MIN) return quieto;
    const foto: ImageBitmap = bmp; // copia estrechada para el closure ver()
    const { det, rec } = await fabrica();
    // Confianza rec media del top-2 (0 si nada legible).
    const confiar = async (cajas: CajaDb[], base: HTMLCanvasElement): Promise<number> => {
      const top = [...cajas].sort((a, b) => b.puntaje - a.puntaje).slice(0, TOP_CAJAS_GIRO);
      const rs = await reconocerLote(rec, base, top, crear);
      const confs: number[] = [];
      for (const r of rs) if (r.texto !== "") confs.push(r.puntaje);
      return confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
    };
    const ver = async (
      grados: Giro,
    ): Promise<{ c: number; masa: number; cajas: CajaDb[]; base: HTMLCanvasElement | null }> => {
      const vacio = { c: 0, masa: 0, cajas: [], base: null };
      const rot = lienzoGirado(foto, grados, crear);
      if (!rot) return vacio;
      const tam = tamanoDet(rot.width, rot.height);
      const base = crear();
      base.width = tam.w;
      base.height = tam.h;
      const ctx = base.getContext("2d");
      if (!ctx) return vacio;
      ctx.drawImage(rot, 0, 0, tam.w, tam.h);
      const sal = await pasarDet(det, base);
      if (!sal) return vacio;
      const masa = masaMapa(sal.mapa);
      const cajas = cajasDesdeMapa(sal.mapa, sal.mw, sal.mh, { ancho: tam.w, alto: tam.h });
      return { c: await confiar(cajas, base), masa, cajas, base };
    };
    let mejor: { g: Giro; c: number; cajas: CajaDb[]; base: HTMLCanvasElement | null } | null =
      null;
    for (const g of GIROS_PRUEBA) {
      let r;
      try {
        r = await ver(g);
      } catch {
        continue; // giro fallido: se salta (el externo aún protege ver(0))
      }
      // P1: puntaje por giro (para ver si el bypass 0.9 es inalcanzable).
      console.info(
        `OCR giro ${g}°: conf=${r.c.toFixed(3)} masa=${r.masa.toFixed(5)} cajas=${r.cajas.length}`,
      );
      if (g === 0 && r.masa < UMBRAL_MAPA_VACIO) return quieto; // sin texto: ni giros
      if (!mejor || r.c > mejor.c) mejor = { g, c: r.c, cajas: r.cajas, base: r.base };
      if (r.c >= UMBRAL_REC_OK) break; // bypass: la primera que convence gana
    }
    if (!mejor) return quieto; // todos los giros fallaron
    // ponytail: sin OK gana el más alto (aunque sea bajo); solo el vacío no gira.
    if (mejor.g === 0) return { blob, grados: 0, cajas: mejor.cajas, base: mejor.base };
    const rot = lienzoGirado(foto, mejor.g, crear);
    const fuera = rot ? await blobDeLienzo(rot) : null;
    if (!fuera) return { blob, grados: 0, cajas: mejor.cajas, base: mejor.base };
    return { blob: fuera, grados: mejor.g, cajas: mejor.cajas, base: mejor.base };
  } catch {
    return quieto;
  } finally {
    bmp?.close();
  }
}

/** Datos Float32 de una salida (sin copiar si ya lo es). */
function datosSalida(sal: SalidaOcr | undefined): Float32Array | null {
  if (!sal) return null;
  return sal.data instanceof Float32Array ? sal.data : Float32Array.from(sal.data);
}

/** Crop BGR de una caja (warp afín del quad a sus aristas). Null si degenerada o sin contexto. */
function recorteCaja(
  base: HTMLCanvasElement,
  caja: CajaDb,
  crear: CrearLienzo,
): { bgr: Uint8Array; w: number; h: number } | null {
  // ponytail: aristas del quad, no bbox (en líneas inclinadas el bbox estira).
  const [q0, q1, , q3] = caja.poli;
  const cw = Math.max(1, Math.ceil(Math.hypot(q1[0] - q0[0], q1[1] - q0[1])));
  const ch = Math.max(1, Math.ceil(Math.hypot(q3[0] - q0[0], q3[1] - q0[1])));
  const inv = matrizInversa(matrizAfin(caja.poli, cw, ch));
  if (!inv) return null;
  const lienzo = crear();
  lienzo.width = cw;
  lienzo.height = ch;
  const ctx = lienzo.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
  try {
    ctx.drawImage(base, 0, 0);
    const datos = ctx.getImageData(0, 0, cw, ch).data;
    return { bgr: bgrDesdeRgba(datos), w: cw, h: ch };
  } catch {
    return null;
  }
}

/** Un run del rec + CTC (vacío si la salida no cuadra o el run falla). */
async function ejecutarRec(
  rec: SubsesionOcr,
  tensor: Float32Array,
  formas: readonly [number, number, number, number],
): Promise<TextoRec> {
  const vacio: TextoRec = { texto: "", puntaje: 0 };
  try {
    const sal = await rec.run({ x: rec.tensor(tensor, [...formas]) });
    const t = datosSalida(sal[SALIDA_ONNX]);
    const pasos = Number(sal[SALIDA_ONNX]?.dims?.[1] ?? 0);
    if (!t || !Number.isInteger(pasos) || pasos < 1) return vacio;
    return decodificarCtc(t, pasos);
  } catch {
    return vacio;
  }
}

/** Reconoce una caja: warp afín del quad a su bbox + rec + CTC. */
export async function reconocerCaja(
  rec: SubsesionOcr,
  base: HTMLCanvasElement,
  caja: CajaDb,
  crear: CrearLienzo,
): Promise<{ texto: string; puntaje: number }> {
  const vacio = { texto: "", puntaje: 0 };
  const r = recorteCaja(base, caja, crear);
  if (!r) return vacio;
  const lin = normalizarLinea(r.bgr, r.w, r.h);
  if (!lin) return vacio;
  return ejecutarRec(rec, lin.tensor, [1, 3, REC_ALTO, lin.anchoTotal]);
}

/** Líneas por chunk del rec (P2: un run [112,1536] tarda ~6s; trozos medianos no). */
const TAMANO_CHUNK_REC = 16;

/**
 * Reconoce N cajas en chunks de un solo run (lote con pad al ancho mayor del
 * grupo; el pad es el mismo del camino individual: se descarta al decodificar).
 * Las líneas se ordenan por ancho para que la hebra ancha no contamine al resto.
 * Si un chunk falla o no cuadra, reintenta una por una. Nunca lanza.
 */
export async function reconocerLote(
  rec: SubsesionOcr,
  base: HTMLCanvasElement,
  cajas: readonly CajaDb[],
  crear: CrearLienzo,
  diag?: DiagRec,
): Promise<TextoRec[]> {
  const fuera: TextoRec[] = cajas.map(() => ({ texto: "", puntaje: 0 }));
  const validos: { idx: number; bgr: Uint8Array; w: number; h: number }[] = [];
  cajas.forEach((caja, idx) => {
    const r = recorteCaja(base, caja, crear);
    if (r) validos.push({ idx, ...r });
  });
  if (validos.length === 0) return fuera;
  // P2: normalizar una vez (el fallback reutiliza, sin renormalizar).
  const norms: { idx: number; lin: LineaNorm }[] = [];
  for (const v of validos) {
    const lin = normalizarLinea(v.bgr, v.w, v.h);
    if (lin) norms.push({ idx: v.idx, lin });
  }
  if (norms.length === 0) return fuera;
  const orden = [...norms].sort((a, b) => a.lin.anchoTotal - b.lin.anchoTotal);
  let anchoMax = 0;
  let chunks = 0;
  let ok = true;
  for (let i = 0; i < orden.length; i += TAMANO_CHUNK_REC) {
    const trozo = orden.slice(i, i + TAMANO_CHUNK_REC);
    const lote = apilarLineas(trozo.map((t) => t.lin));
    const sal = lote
      ? await rec
          .run({ x: rec.tensor(lote.tensor, [lote.lote, 3, REC_ALTO, lote.anchoMax]) })
          .catch((): null => null)
      : null;
    const datos = sal ? datosSalida(sal[SALIDA_ONNX]) : null;
    const pasos = Number(sal?.[SALIDA_ONNX]?.dims?.[1] ?? 0);
    const porLote = datos && lote ? datos.length / lote.lote : 0;
    if (
      !datos ||
      !lote ||
      !Number.isInteger(pasos) ||
      pasos < 1 ||
      !Number.isInteger(porLote) ||
      porLote / pasos !== DICT_OCR.length
    ) {
      ok = false; // el chunk no cuadra (EP sin batch, formas raras): individual abajo.
      break;
    }
    trozo.forEach((t, b) => {
      fuera[t.idx] = decodificarCtc(datos.subarray(b * porLote, (b + 1) * porLote), pasos);
    });
    chunks += 1;
    if (lote.anchoMax > anchoMax) anchoMax = lote.anchoMax;
  }
  if (diag) {
    diag.lote = norms.length;
    diag.anchoMax = anchoMax;
    diag.recRuns = chunks;
  }
  if (ok) return fuera;
  for (const n of norms) {
    fuera[n.idx] = await ejecutarRec(rec, n.lin.tensor, [1, 3, REC_ALTO, n.lin.anchoTotal]);
  }
  if (diag) {
    diag.fallback = true;
    diag.recRuns = norms.length;
    diag.anchoMax = Math.max(...norms.map((n) => n.lin.anchoTotal));
  }
  return fuera;
}

/**
 * Blob recortado → texto OCR plano por líneas. Nunca lanza: sin texto o con
 * error devuelve "" (la cola sigue y el monto queda manual).
 */
export async function extraerTexto(
  blob: Blob,
  deps?: DepsOcr,
  reuse?: Pick<Enderezado, "cajas" | "base">,
  diag?: DiagRec,
): Promise<string> {
  const cargar = deps?.cargar ?? cargarReal;
  const crear = deps?.crear ?? crearReal;
  const fabrica = deps?.nucleo ?? obtenerNucleo;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await cargar(blob, { imageOrientation: "from-image" });
    if (bmp.width < DET_LADO_MIN || bmp.height < DET_LADO_MIN) return "";
    const tam = tamanoDet(bmp.width, bmp.height);
    const base = crear();
    base.width = tam.w;
    base.height = tam.h;
    const bctx = base.getContext("2d");
    if (!bctx) return "";
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(bmp, 0, 0, tam.w, tam.h);
    const { det, rec } = await fabrica();
    // L1: el enderezado ya calculó cajas/base del giro ganador; se reutilizan.
    let cajas: CajaDb[];
    let final: HTMLCanvasElement;
    if (reuse?.base && reuse.cajas.length > 0) {
      cajas = [...reuse.cajas];
      final = reuse.base;
    } else {
      const salDet = await pasarDet(det, base);
      if (!salDet) return "";
      const { mapa, mw, mh } = salDet;
      cajas = cajasDesdeMapa(mapa, mw, mh, { ancho: tam.w, alto: tam.h });
      final = base;
    }
    const lineas: string[] = [];
    // L2: un solo run para todas las cajas (con fallback individual dentro).
    if (diag) diag.cajas = cajas.length;
    for (const r of await reconocerLote(rec, final, cajas, crear, diag)) {
      // ponytail: líneas vacías fuera (el modal queda limpio para el LLM).
      if (r.texto !== "") lineas.push(r.texto);
    }
    return lineas.join("\n");
  } catch (e: unknown) {
    console.warn(`OCR: texto omitido (${e instanceof Error ? e.message : String(e)})`);
    return "";
  } finally {
    bmp?.close();
  }
}
