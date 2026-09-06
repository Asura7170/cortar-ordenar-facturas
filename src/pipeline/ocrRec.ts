/* Reconocimiento PP-OCRv6_small_rec: normalización de línea + CTC greedy.
   Puro y testeable sin onnx (el lienzo solo lo toca ocr.ts).
   Receta de PaddleOCR (resize_norm_img_chinese + CTCLabelDecode):
   h→48 con aspecto, ancho útil sin truncar a 320, (x/255−0.5)/0.5, pad a
   derecha; argmax por paso, colapsar repetidos, quitar blank=0. */

import { DICT_OCR } from "./ocrDict";
import type { CajaDb } from "./ocrDb";

/** Alto fijo de entrada del rec (image_shape [3,48,320]). */
export const REC_ALTO: number = 48;
/** Ancho base (crece con el aspecto: resize_norm_img_chinese no trunca). */
export const REC_ANCHO_BASE: number = 320;

/** Línea lista para el tensor [1,3,48,anchoTotal] (CHW aplanado). */
export interface LineaNorm {
  readonly tensor: Float32Array;
  readonly anchoUtil: number;
  readonly anchoTotal: number;
}

/** Muestreo bilineal de un canal sobre BGR plano (bordes por réplica). */
function bilineal(
  bgr: Uint8Array,
  w: number,
  h: number,
  canal: number,
  x: number,
  y: number,
): number {
  const xc = Math.min(w - 1, Math.max(0, x));
  const yc = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = bgr[(y0 * w + x0) * 3 + canal] ?? 0;
  const p10 = bgr[(y0 * w + x1) * 3 + canal] ?? 0;
  const p01 = bgr[(y1 * w + x0) * 3 + canal] ?? 0;
  const p11 = bgr[(y1 * w + x1) * 3 + canal] ?? 0;
  return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
}

/**
 * Normaliza un crop BGR (w×h) a tensor CHW [3,48,anchoTotal].
 * Null si es degenerado.
 */
export function normalizarLinea(bgr: Uint8Array, w: number, h: number): LineaNorm | null {
  if (w < 1 || h < 1 || bgr.length < w * h * 3) return null;
  const ratio = w / h;
  // ponytail: sin truncar a 320 (resize_norm_img_chinese ensancha imgW con el aspecto).
  const anchoTotal = Math.max(
    REC_ANCHO_BASE,
    Math.floor(REC_ALTO * Math.max(REC_ANCHO_BASE / REC_ALTO, ratio)),
  );
  const anchoUtil = Math.min(anchoTotal, Math.max(1, Math.ceil(REC_ALTO * ratio)));
  const tensor = new Float32Array(3 * REC_ALTO * anchoTotal);
  const plano = REC_ALTO * anchoTotal;
  for (let y = 0; y < REC_ALTO; y += 1) {
    const fy = ((y + 0.5) * h) / REC_ALTO - 0.5;
    for (let x = 0; x < anchoUtil; x += 1) {
      const fx = ((x + 0.5) * w) / anchoUtil - 0.5;
      for (let c = 0; c < 3; c += 1) {
        const v = bilineal(bgr, w, h, c, fx, fy);
        tensor[c * plano + y * anchoTotal + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return { tensor, anchoUtil, anchoTotal };
}

/** Matriz afín canvas [a,b,c,d,e,f]. */
export type MatrizAfin = readonly [number, number, number, number, number, number];

/**
 * Matriz afín canvas [a,b,c,d,e,f] que lleva el rect (0,0,W,H) al quad
 * (p0=sup-izq, p1=sup-der, p3=inf-izq). Exacta porque el quad de minAreaRect
 * es un paralelogramo (p0+p2 == p1+p3).
 */
export function matrizAfin(poli: CajaDb["poli"], w: number, h: number): MatrizAfin {
  const [p0, p1, , p3] = poli;
  return [
    (p1[0] - p0[0]) / w,
    (p1[1] - p0[1]) / w,
    (p3[0] - p0[0]) / h,
    (p3[1] - p0[1]) / h,
    p0[0],
    p0[1],
  ];
}

/** Inversa de una matriz afín (para dibujar el quad enderezado). Null si degenerada. */
export function matrizInversa(m: MatrizAfin): MatrizAfin | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Texto reconocido + puntaje medio de sus caracteres. */
export interface TextoRec {
  readonly texto: string;
  readonly puntaje: number;
}

/**
 * CTC greedy sobre logits [pasos, clases]: argmax, colapsar repetidos,
 * quitar blank (0). Vacío si las formas no cuadran con el dict.
 */
export function decodificarCtc(
  logits: Float32Array,
  pasos: number,
  dict: readonly string[] = DICT_OCR,
): TextoRec {
  if (pasos < 1 || logits.length % pasos !== 0) return { texto: "", puntaje: 0 };
  const clases = logits.length / pasos;
  if (clases !== dict.length) return { texto: "", puntaje: 0 };
  let texto = "";
  let suma = 0;
  let n = 0;
  let previo = -1;
  for (let t = 0; t < pasos; t += 1) {
    let mejor = 0;
    let mejorV = -Infinity;
    for (let c = 0; c < clases; c += 1) {
      const v = logits[t * clases + c] ?? -Infinity;
      if (v > mejorV) {
        mejorV = v;
        mejor = c;
      }
    }
    if (mejor !== 0 && mejor !== previo) {
      texto += dict[mejor] ?? "";
      suma += mejorV;
      n += 1;
    }
    previo = mejor;
  }
  return { texto, puntaje: n > 0 ? suma / n : 0 };
}
