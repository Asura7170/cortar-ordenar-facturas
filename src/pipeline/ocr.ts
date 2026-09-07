/* OCR PP-OCRv6_small: detección de líneas + reconocimiento con onnxruntime-web.
   Sin dependencias nuevas: modelos en public/models/ocr, pre/post-proceso en
   ocrDb.ts/ocrRec.ts. Entrada: blob ya recortado por DocAligner; salida:
   texto plano por líneas ("" si no hay texto o algo falla: la cola sigue). */
import { TIMEOUT_EP_MS, iniciarSesion } from "./docaligner";
import { DICT_OCR } from "./ocrDict";
import { cajasDesdeMapa } from "./ocrDb";
import type { CajaDb } from "./ocrDb";
import { decodificarCtc, matrizAfin, matrizInversa, normalizarLinea, REC_ALTO } from "./ocrRec";
import { cargarReal, crearReal } from "./imagen";
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
function envolver(
  ort: OrtModulo,
  sesion: import("onnxruntime-web").InferenceSession,
  nombre: string,
): SubsesionOcr {
  if (nombre === "rec") {
    // ponytail: en ort-web 1.29 los metadatos son arreglos alineados con los nombres.
    const meta = sesion.outputMetadata[0];
    const dims = (meta && "dimensions" in meta ? meta.dimensions : undefined) as
      | ReadonlyArray<number | string>
      | undefined;
    const clases = dims?.[dims.length - 1];
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
  const crear =
    (pesos: ArrayBuffer, nombre: string) =>
    async (ep: string): Promise<SubsesionOcr> => {
      const sesion = await ort.InferenceSession.create(pesos, {
        executionProviders: [ep],
        graphOptimizationLevel: "all",
      });
      return envolver(ort, sesion, nombre);
    };
  // ponytail: las bajadas en paralelo (la mitad del tiempo); las sesiones en
  // serie (compiten por el mismo contexto GPU). El latch de EPs caídos sigue
  // compartido con docaligner: si webgpu murió ahí, aquí ni se intenta.
  const [detBuf, recBuf] = await Promise.all([
    descargarModelo(RUTA_DET),
    descargarModelo(RUTA_REC),
  ]);
  const det = await iniciarSesion(crear(detBuf, "det"));
  const rec = await iniciarSesion(crear(recBuf, "rec"));
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

/** Nombre del tensor de salida en ambos onnx (fetch_name_0). */
const SALIDA_ONNX = "fetch_name_0";

/** Datos Float32 de una salida (sin copiar si ya lo es). */
function datosSalida(sal: SalidaOcr | undefined): Float32Array | null {
  if (!sal) return null;
  return sal.data instanceof Float32Array ? sal.data : Float32Array.from(sal.data);
}

/** Reconoce una caja: warp afín del quad a su bbox + rec + CTC. */
export async function reconocerCaja(
  rec: SubsesionOcr,
  base: HTMLCanvasElement,
  caja: CajaDb,
  crear: CrearLienzo,
): Promise<{ texto: string; puntaje: number }> {
  const vacio = { texto: "", puntaje: 0 };
  const xs = caja.poli.map((p) => p[0]);
  const ys = caja.poli.map((p) => p[1]);
  const cw = Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs)));
  const ch = Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys)));
  const inv = matrizInversa(matrizAfin(caja.poli, cw, ch));
  if (!inv) return vacio;
  const lienzo = crear();
  lienzo.width = cw;
  lienzo.height = ch;
  const ctx = lienzo.getContext("2d");
  if (!ctx) return vacio;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
  try {
    ctx.drawImage(base, 0, 0);
    const datos = ctx.getImageData(0, 0, cw, ch).data;
    const lin = normalizarLinea(bgrDesdeRgba(datos), cw, ch);
    if (!lin) return vacio;
    const sal = await rec.run({
      x: rec.tensor(lin.tensor, [1, 3, REC_ALTO, lin.anchoTotal]),
    });
    const t = datosSalida(sal[SALIDA_ONNX]);
    const dims = sal[SALIDA_ONNX]?.dims;
    const pasos = Number(dims?.[1] ?? 0);
    if (!t || !Number.isInteger(pasos) || pasos < 1) return vacio;
    return decodificarCtc(t, pasos);
  } catch {
    return vacio;
  }
}

/**
 * Blob recortado → texto OCR plano por líneas. Nunca lanza: sin texto o con
 * error devuelve "" (la cola sigue y el monto queda manual).
 */
export async function extraerTexto(blob: Blob, deps?: DepsOcr): Promise<string> {
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
    const bdatos = bctx.getImageData(0, 0, tam.w, tam.h).data;
    const { det, rec } = await fabrica();
    const salDet = await det.run({
      x: det.tensor(tensorDet(bgrDesdeRgba(bdatos), tam.w, tam.h), [1, 3, tam.h, tam.w]),
    });
    const mapa = datosSalida(salDet[SALIDA_ONNX]);
    const dims = salDet[SALIDA_ONNX]?.dims;
    const mh = Number(dims?.[2] ?? 0);
    const mw = Number(dims?.[3] ?? 0);
    if (!mapa || !Number.isInteger(mh) || !Number.isInteger(mw) || mh < 1 || mw < 1) return "";
    const cajas = cajasDesdeMapa(mapa, mw, mh, { ancho: tam.w, alto: tam.h });
    const lineas: string[] = [];
    for (const caja of cajas) {
      // ponytail: líneas vacías fuera (el modal queda limpio para el LLM).
      const r = await reconocerCaja(rec, base, caja, crear);
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
