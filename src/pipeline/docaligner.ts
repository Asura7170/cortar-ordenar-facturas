/* Detección de esquinas DocAligner (heatmap/lcnet100) + warp perspectiva en canvas.
   Geometría y decode portados de andor83/ml-web-scanner (MIT — ver public/models/NOTICE.txt);
   pesos DocAligner de DocsaidLab (Apache-2.0 — ver public/models/NOTICE.txt).
   Entrada: blob JPEG ya normalizado (imagen.ts: EXIF + tope + blancas). Fallo → blob original. */
import { CALIDAD_JPEG } from "./imagen";
import type { CargarBitmap, CrearLienzo } from "./imagen";

/** Punto en píxeles de la imagen original. */
export interface Punto {
  readonly x: number;
  readonly y: number;
}

/** Cuatro esquinas ordenadas: sup-izq, sup-der, inf-der, inf-izq. */
export type Quad = readonly [Punto, Punto, Punto, Punto];

/** Búfer de píxeles RGBA para el warp (testeable sin DOM). */
export interface BuferPixeles {
  readonly datos: Uint8ClampedArray<ArrayBuffer>;
  readonly ancho: number;
  readonly alto: number;
}

/** Lado del tensor cuadrado del modelo (256×256, aspecto achatado como el pipeline de referencia). */
export const LADO_MODELO: number = 256;

/** Borde negro alrededor de la foto para que el modelo extrapole esquinas cortadas (receta del demo DocAligner). */
export const PAD_BORDE: number = 100;

/** Binarización del heatmap por canal (mismo valor que el gate de confianza). */
export const UMBRAL_HEATMAP: number = 0.3;

/** Modelo vendoreado same-origin (COEP require-corp bloquea CDNs sin cabecera CORP). */
export const RUTA_MODELO: string = `${import.meta.env.BASE_URL}models/lcnet100_h_e_bifpn_256_fp32.onnx`;

/** Arista máxima de salida del warp (heredado; el ticket medio no lo toca). */
const ARISTA_MAX_SALIDA = 4096;

/** Ordena 4 puntos arbitrarios como Quad por ángulo alrededor del centroide. Lanza si no son 4. */
export function ordenarQuad(puntos: readonly Punto[]): Quad {
  if (puntos.length !== 4) throw new Error(`ordenarQuad espera 4 puntos, llegan ${puntos.length}`);
  const a = puntos[0];
  const b = puntos[1];
  const c = puntos[2];
  const d = puntos[3];
  if (!a || !b || !c || !d) throw new Error("ordenarQuad: puntos ausentes");
  const cx = (a.x + b.x + c.x + d.x) / 4;
  const cy = (a.y + b.y + c.y + d.y) / 4;
  const orden = [a, b, c, d].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );
  let inicio = 0;
  let mejor = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = orden[i];
    if (!p) continue;
    const s = p.x + p.y;
    if (s < mejor) {
      mejor = s;
      inicio = i;
    }
  }
  const p0 = orden[inicio];
  const p1 = orden[(inicio + 1) % 4];
  const p2 = orden[(inicio + 2) % 4];
  const p3 = orden[(inicio + 3) % 4];
  if (!p0 || !p1 || !p2 || !p3) throw new Error("ordenarQuad: orden incompleto");
  return [p0, p1, p2, p3];
}

/** True si el quad es convexo (sin autointersección ni esquina reflexiva). */
export function esConvexo(quad: Quad): boolean {
  const [a, b, c, d] = quad;
  const cruces = [
    (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
    (c.x - b.x) * (d.y - c.y) - (c.y - b.y) * (d.x - c.x),
    (d.x - c.x) * (a.y - d.y) - (d.y - c.y) * (a.x - d.x),
    (a.x - d.x) * (b.y - a.y) - (a.y - d.y) * (b.x - a.x),
  ];
  let signo = 0;
  for (const cruz of cruces) {
    if (cruz === 0) return false;
    const s = Math.sign(cruz);
    if (signo === 0) signo = s;
    else if (s !== signo) return false;
  }
  return true;
}

/** Área por shoelace (siempre positiva). */
export function areaQuad(quad: Quad): number {
  const [a, b, c, d] = quad;
  return (
    Math.abs(
      a.x * b.y -
        b.x * a.y +
        (b.x * c.y - c.x * b.y) +
        (c.x * d.y - d.x * c.y) +
        (d.x * a.y - a.x * d.y),
    ) / 2
  );
}

/** Longitudes [sup, der, inf, izq]. */
export function ladosQuad(quad: Quad): [number, number, number, number] {
  const [a, b, c, d] = quad;
  const dist = (p: Punto, q: Punto): number => Math.hypot(q.x - p.x, q.y - p.y);
  return [dist(a, b), dist(b, c), dist(c, d), dist(d, a)];
}

/** Gate de plausibilidad de un disparo (umbrales del DetectionGate de referencia, sin histéresis: 1 disparo). */
export function esQuadPlausible(
  quad: Quad | null,
  confianzas: readonly number[],
  ancho: number,
  alto: number,
): quad is Quad {
  if (!quad) return false;
  if (confianzas.length === 4 && Math.min(...confianzas) < UMBRAL_HEATMAP) return false;
  if (!esConvexo(quad)) return false;
  const areaMarco = ancho * alto;
  const area = areaQuad(quad);
  if (area < areaMarco * 0.05 || area > areaMarco * 0.98) return false;
  const diagonal = Math.hypot(ancho, alto);
  if (Math.min(...ladosQuad(quad)) < diagonal * 0.05) return false;
  return true;
}

/** Homografía 3×3 (fila-mayor, h[8]=1) tal que H·src[i] ~ dst[i]. Lanza si degenera. */
export function calcularHomografia(
  destino: readonly Punto[],
  origen: readonly Punto[],
): Float64Array {
  // ponytail: DLT 4 puntos con Gauss+privoteo; librería solo si otro módulo lo pide.
  const s0 = destino[0];
  const s1 = destino[1];
  const s2 = destino[2];
  const s3 = destino[3];
  const d0 = origen[0];
  const d1 = origen[1];
  const d2 = origen[2];
  const d3 = origen[3];
  if (!s0 || !s1 || !s2 || !s3 || !d0 || !d1 || !d2 || !d3) {
    throw new Error("calcularHomografia espera 4 pares de puntos");
  }
  const src = [s0, s1, s2, s3];
  const dst = [d0, d1, d2, d3];
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i];
    const d = dst[i];
    if (!s || !d) throw new Error("calcularHomografia: par ausente");
    a.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x]);
    b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y]);
    b.push(d.y);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let fil = col + 1; fil < n; fil++) {
      const actual = a[fil]?.[col] ?? 0;
      const mejor = a[piv]?.[col] ?? 0;
      if (Math.abs(actual) > Math.abs(mejor)) piv = fil;
    }
    if (Math.abs(a[piv]?.[col] ?? 0) < 1e-12) {
      throw new Error("calcularHomografia: configuración degenerada");
    }
    if (piv !== col) {
      const fa = a[col];
      const fb = a[piv];
      if (fa && fb) {
        a[col] = fb;
        a[piv] = fa;
      }
      const ba = b[col] ?? 0;
      b[col] = b[piv] ?? 0;
      b[piv] = ba;
    }
    const div = a[col]?.[col] ?? 1;
    for (let k = col; k < n; k++) {
      const fila = a[col];
      if (fila) fila[k] = (fila[k] ?? 0) / div;
    }
    b[col] = (b[col] ?? 0) / div;
    for (let fil = 0; fil < n; fil++) {
      if (fil === col) continue;
      const factor = a[fil]?.[col] ?? 0;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) {
        const fr = a[fil];
        const fc = a[col];
        if (fr && fc) fr[k] = (fr[k] ?? 0) - factor * (fc[k] ?? 0);
      }
      b[fil] = (b[fil] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const h = new Float64Array(9);
  for (let i = 0; i < 8; i++) h[i] = b[i] ?? 0;
  h[8] = 1;
  return h;
}

/** Tamaño natural de salida: ancho = media de aristas sup/inf, alto = media de laterales. */
export function tamanoSalida(quad: Quad): { width: number; height: number } {
  const [sup, der, inf, izq] = ladosQuad(quad);
  const fija = (v: number): number => Math.max(1, Math.min(ARISTA_MAX_SALIDA, Math.round(v)));
  return { width: fija((sup + inf) / 2), height: fija((izq + der) / 2) };
}

/** Mapeo inverso rectángulo-destino → quad-origen (lo que el warp necesita). */
function homografiaDestOrigen(quad: Quad, ancho: number, alto: number): Float64Array {
  return calcularHomografia(
    [
      { x: 0, y: 0 },
      { x: ancho - 1, y: 0 },
      { x: ancho - 1, y: alto - 1 },
      { x: 0, y: alto - 1 },
    ],
    [...quad],
  );
}

/** Warp perspectiva por mapeo inverso + muestreo bilineal. Fuera del quad: blanco (el JPEG no tiene alpha). */
export function warpear(src: BuferPixeles, quad: Quad, ancho: number, alto: number): BuferPixeles {
  const h = homografiaDestOrigen(quad, ancho, alto);
  const fuera = new Uint8ClampedArray(ancho * alto * 4);
  fuera.fill(255);
  const ent = src.datos;
  const an = src.ancho;
  const al = src.alto;
  const h0 = h[0] ?? 0;
  const h1 = h[1] ?? 0;
  const h2 = h[2] ?? 0;
  const h3 = h[3] ?? 0;
  const h4 = h[4] ?? 0;
  const h5 = h[5] ?? 0;
  const h6 = h[6] ?? 0;
  const h7 = h[7] ?? 0;
  const h8 = h[8] ?? 1;
  for (let v = 0; v < alto; v++) {
    let X = h1 * v + h2;
    let Y = h4 * v + h5;
    let W = h7 * v + h8;
    let o = v * ancho * 4;
    for (let u = 0; u < ancho; u++, X += h0, Y += h3, W += h6, o += 4) {
      const sx = X / W;
      const sy = Y / W;
      // ponytail: clamp en vez de saltar el borde (la referencia lo recortaba: en video no se nota, en foto sí).
      if (sx < 0 || sy < 0 || sx > an - 1 || sy > al - 1) continue;
      const x0 = Math.max(0, Math.min(an - 2, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(al - 2, Math.floor(sy)));
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * an + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + an * 4;
      const i11 = i01 + 4;
      fuera[o] =
        (ent[i00] ?? 0) * w00 +
        (ent[i10] ?? 0) * w10 +
        (ent[i01] ?? 0) * w01 +
        (ent[i11] ?? 0) * w11;
      fuera[o + 1] =
        (ent[i00 + 1] ?? 0) * w00 +
        (ent[i10 + 1] ?? 0) * w10 +
        (ent[i01 + 1] ?? 0) * w01 +
        (ent[i11 + 1] ?? 0) * w11;
      fuera[o + 2] =
        (ent[i00 + 2] ?? 0) * w00 +
        (ent[i10 + 2] ?? 0) * w10 +
        (ent[i01 + 2] ?? 0) * w01 +
        (ent[i11 + 2] ?? 0) * w11;
      fuera[o + 3] = 255;
    }
  }
  return { datos: fuera, ancho, alto };
}

// Búfers reutilizados entre disparos (un disparo a la vez: la cola es secuencial).
let visitados: Uint8Array | null = null;
let pila: Int32Array | null = null;

/** Decodifica un heatmap (1,4,H,W) a esquinas en píxeles: por canal, centroide ponderado del blob mayor. */
export function decodificarHeatmap(
  heat: Float32Array,
  dims: readonly number[],
  ancho: number,
  alto: number,
  umbral: number = UMBRAL_HEATMAP,
): { quad: Quad | null; confianzas: number[] } {
  const h = dims[2] ?? 0;
  const w = dims[3] ?? 0;
  const plano = h * w;
  if (plano < 1) return { quad: null, confianzas: [] };
  if (!visitados || visitados.length < plano) {
    visitados = new Uint8Array(plano);
    pila = new Int32Array(plano);
  }
  const puntos: Punto[] = [];
  const confianzas: number[] = [];
  for (let c = 0; c < 4; c++) {
    const base = c * plano;
    visitados.fill(0);
    let mejorMasa = 0;
    let mejorX = -1;
    let mejorY = -1;
    let pico = 0;
    for (let ini = 0; ini < plano; ini++) {
      const v = heat[base + ini] ?? 0;
      if (v > pico) pico = v;
      if (v < umbral || (visitados[ini] ?? 0) === 1) continue;
      let cima = 0;
      const pl = pila;
      if (!pl) continue;
      pl[cima++] = ini;
      visitados[ini] = 1;
      let masa = 0;
      let sumaX = 0;
      let sumaY = 0;
      while (cima > 0) {
        const idx = pl[--cima] ?? 0;
        const val = heat[base + idx] ?? 0;
        const x = idx % w;
        const y = (idx / w) | 0;
        masa += val;
        sumaX += x * val;
        sumaY += y * val;
        if (x > 0 && (visitados[idx - 1] ?? 0) === 0 && (heat[base + idx - 1] ?? 0) >= umbral) {
          visitados[idx - 1] = 1;
          pl[cima++] = idx - 1;
        }
        if (x < w - 1 && (visitados[idx + 1] ?? 0) === 0 && (heat[base + idx + 1] ?? 0) >= umbral) {
          visitados[idx + 1] = 1;
          pl[cima++] = idx + 1;
        }
        if (y > 0 && (visitados[idx - w] ?? 0) === 0 && (heat[base + idx - w] ?? 0) >= umbral) {
          visitados[idx - w] = 1;
          pl[cima++] = idx - w;
        }
        if (y < h - 1 && (visitados[idx + w] ?? 0) === 0 && (heat[base + idx + w] ?? 0) >= umbral) {
          visitados[idx + w] = 1;
          pl[cima++] = idx + w;
        }
      }
      if (masa > mejorMasa) {
        mejorMasa = masa;
        mejorX = sumaX / masa;
        mejorY = sumaY / masa;
      }
    }
    confianzas.push(pico);
    if (mejorMasa === 0) continue;
    // +0.5 centra la muestra en su celda antes de escalar.
    puntos.push({ x: ((mejorX + 0.5) / w) * ancho, y: ((mejorY + 0.5) / h) * alto });
  }
  if (puntos.length !== 4) return { quad: null, confianzas };
  const quad = ordenarQuad(puntos);
  if (!esConvexo(quad)) return { quad: null, confianzas };
  return { quad, confianzas };
}

/** Sesión mínima que el detector necesita (seam inyectable: los tests la stubban, sin onnx). */
export interface SesionDetectora {
  readonly inferir: (
    tensor: Float32Array,
  ) => Promise<{ datos: Float32Array; dims: readonly number[] }>;
}

const cargarReal: CargarBitmap = (f, opc) => createImageBitmap(f, opc);
const crearReal: CrearLienzo = () => document.createElement("canvas");

/** Fuente dibujable: bitmap decodificado o lienzo con borde (ambos exponen width/height). */
export type FuenteDibujable = ImageBitmap | HTMLCanvasElement;

/** Bitmap → tensor CHW RGB 0..1 de 256×256 (aspecto achatado, como la referencia). */
export function bitmapATensor(bmp: FuenteDibujable, crear: CrearLienzo = crearReal): Float32Array {
  const lienzo = crear();
  lienzo.width = LADO_MODELO;
  lienzo.height = LADO_MODELO;
  const ctx = lienzo.getContext("2d");
  if (!ctx) throw new Error("tensor: sin contexto 2d");
  ctx.drawImage(bmp, 0, 0, LADO_MODELO, LADO_MODELO);
  const { data } = ctx.getImageData(0, 0, LADO_MODELO, LADO_MODELO);
  const plano = LADO_MODELO * LADO_MODELO;
  const tensor = new Float32Array(3 * plano);
  for (let i = 0; i < plano; i++) {
    const j = i * 4;
    tensor[i] = (data[j] ?? 0) / 255;
    tensor[i + plano] = (data[j + 1] ?? 0) / 255;
    tensor[i + 2 * plano] = (data[j + 2] ?? 0) / 255;
  }
  return tensor;
}

/** Una inferencia: tensor → heatmap → quad plausible en píxeles, o null. */
export async function detectarEsquinas(
  bmp: FuenteDibujable,
  sesion: SesionDetectora,
  crear: CrearLienzo = crearReal,
  umbral: number = UMBRAL_HEATMAP,
): Promise<Quad | null> {
  const tensor = bitmapATensor(bmp, crear);
  const { datos, dims } = await sesion.inferir(tensor);
  const { quad, confianzas } = decodificarHeatmap(datos, dims, bmp.width, bmp.height, umbral);
  return esQuadPlausible(quad, confianzas, bmp.width, bmp.height) ? quad : null;
}

/** Recorta el quad a JPEG (misma calidad única del pipeline). Lanza si no hay contexto/blob. */
export async function rectificar(
  bmp: ImageBitmap,
  quad: Quad,
  crear: CrearLienzo = crearReal,
): Promise<Blob> {
  const lienzo = crear();
  lienzo.width = bmp.width;
  lienzo.height = bmp.height;
  const ctx = lienzo.getContext("2d");
  if (!ctx) throw new Error("rectificar: sin contexto 2d");
  ctx.drawImage(bmp, 0, 0);
  const pix = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const { width, height } = tamanoSalida(quad);
  const fuera = warpear(
    { datos: pix.data, ancho: bmp.width, alto: bmp.height },
    quad,
    width,
    height,
  );
  lienzo.width = width;
  lienzo.height = height;
  const ctx2 = lienzo.getContext("2d");
  if (!ctx2) throw new Error("rectificar: sin contexto 2d");
  ctx2.putImageData(new ImageData(fuera.datos, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((res) =>
    lienzo.toBlob(res, "image/jpeg", CALIDAD_JPEG),
  );
  if (!blob) throw new Error("rectificar: sin blob");
  return blob;
}

/** Deps inyectables del paso completo (por defecto: reales; los tests las stubban). */
export interface DepsRecorte {
  readonly cargar?: CargarBitmap;
  readonly crear?: CrearLienzo;
  readonly sesion?: () => Promise<SesionDetectora>;
}

let sesionEnCurso: Promise<SesionDetectora> | null = null;

/** Singleton lazy de la sesión ORT (import dinámico: onnx solo se descarga con el primer comprobante). */
export function obtenerSesion(): Promise<SesionDetectora> {
  if (!sesionEnCurso) {
    sesionEnCurso = crearSesion().catch((e: unknown) => {
      sesionEnCurso = null; // el siguiente comprobante reintenta
      throw e;
    });
  }
  return sesionEnCurso;
}

/** Presupuesto por intento de EP: un compile sano tarda ~1s; más es hardware colgado (ORT no siempre rechaza). */
export const TIMEOUT_EP_MS: number = 30_000;

/** EPs caídos en esta carga (fallo o timeout): el fallo de init es determinista, no se reintentan. */
const epCaidos = new Set<string>();

/** Olvida los EPs caídos (seam de tests; el siguiente comprobante los reintenta). */
export function reintentarEps(): void {
  epCaidos.clear();
}

/** Race con rechazo por timeout; un solo handle, siempre limpiado (sin rechazos sin manejar). */
export function conTimeout<T>(promesa: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resuelve, rechaza) => {
    const id = setTimeout(() => rechaza(new Error(`timeout tras ${ms}ms`)), ms);
    promesa.then(
      (v) => {
        clearTimeout(id);
        resuelve(v);
      },
      (e: unknown) => {
        clearTimeout(id);
        rechaza(e);
      },
    );
  });
}

/** Intento de un EP (seam inyectable: los tests lo stubban, sin onnx). */
export type IntentarEp = (ep: string) => Promise<SesionDetectora>;

/** Prueba EPs en orden con timeout y latch de caídos; lanza si ninguno sirve. */
export async function iniciarSesion(
  intentar: IntentarEp,
  eps: readonly string[] = ["webgpu", "wasm"],
  timeoutMs: number = TIMEOUT_EP_MS,
): Promise<SesionDetectora> {
  let ultimoError: unknown = null;
  for (const ep of eps) {
    if (epCaidos.has(ep)) continue;
    try {
      return await conTimeout(intentar(ep), timeoutMs);
    } catch (e: unknown) {
      epCaidos.add(ep);
      ultimoError = e;
      console.warn(
        `DocAligner: EP ${ep} no disponible, se omite (${e instanceof Error ? e.message : e})`,
      );
    }
  }
  throw ultimoError instanceof Error ? ultimoError : new Error("ORT sin proveedor válido");
}

async function crearSesion(): Promise<SesionDetectora> {
  // ponytail: build solo-webgpu (sin jsep deprecado ni webgl): el dist pasa de ~30MB a <1MB.
  const ort = await import("onnxruntime-web/webgpu");
  // ponytail: wasmPaths copiado de node_modules (los nombres cambian por minor, no van por CDN).
  ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
  // ponytail: single-thread a propósito — los workers pthread del build threaded los bloquea
  // Chrome bajo COEP require-corp (y en headless cuelgan sin rechazar); ~250ms/foto bastan.
  ort.env.wasm.numThreads = 1;
  const res = await fetch(RUTA_MODELO);
  if (!res.ok) throw new Error(`modelo DocAligner: HTTP ${res.status}`);
  const pesos = await res.arrayBuffer();
  return iniciarSesion(async (ep: string): Promise<SesionDetectora> => {
    const s = await ort.InferenceSession.create(pesos, {
      executionProviders: [ep],
      graphOptimizationLevel: "all",
    });
    const entrada = s.inputNames[0] ?? "img";
    const salida = s.outputNames[0] ?? "heatmap";
    return {
      inferir: async (
        tensor: Float32Array,
      ): Promise<{ datos: Float32Array; dims: readonly number[] }> => {
        const t = new ort.Tensor("float32", tensor, [1, 3, LADO_MODELO, LADO_MODELO]);
        const sal = await s.run({ [entrada]: t });
        const o = sal[salida];
        if (!o) throw new Error("modelo sin salida heatmap");
        return { datos: o.data as Float32Array, dims: [...o.dims] };
      },
    };
  });
}

/** Lienzo con borde negro alrededor del bitmap (capybara.pad con pad_value=0). Lanza sin contexto. */
export function conBorde(
  bmp: ImageBitmap,
  crear: CrearLienzo = crearReal,
  pad: number = PAD_BORDE,
): HTMLCanvasElement {
  const lienzo = crear();
  lienzo.width = bmp.width + pad * 2;
  lienzo.height = bmp.height + pad * 2;
  const ctx = lienzo.getContext("2d");
  if (!ctx) throw new Error("borde: sin contexto 2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(bmp, pad, pad);
  return lienzo;
}

/** Resta el borde a un quad (la traslación conserva orden y convexidad). */
export function quitarBorde(quad: Quad, pad: number = PAD_BORDE): Quad {
  const [a, b, c, d] = quad;
  const mueve = (p: Punto): Punto => ({ x: p.x - pad, y: p.y - pad });
  return [mueve(a), mueve(b), mueve(c), mueve(d)];
}

/** Paso completo: blob → esquinas (sobre foto con borde) → JPEG recortado. Nunca lanza: sin esquinas o con error devuelve el original. */
export async function detectarYRecortar(blob: Blob, deps?: DepsRecorte): Promise<Blob> {
  const cargar = deps?.cargar ?? cargarReal;
  const crear = deps?.crear ?? crearReal;
  const fabrica = deps?.sesion ?? obtenerSesion;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await cargar(blob, { imageOrientation: "from-image" });
    const base = conBorde(bmp, crear);
    const sesion = await fabrica();
    const quad = await detectarEsquinas(base, sesion, crear);
    if (!quad) return blob;
    return await rectificar(bmp, quitarBorde(quad), crear);
  } catch {
    return blob;
  } finally {
    bmp?.close();
  }
}
