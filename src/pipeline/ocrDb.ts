/* Post-proceso DB de PP-OCRv6_small_det: mapa de probabilidad → cajas de texto.
   Puro y testeable sin onnx: el mapa entra como Float32Array plano.
   Receta de PaddleOCR (db_postprocess.py): binarizar, componentes conexos,
   minAreaRect, puntuar por media interior, expandir (unclip) y reescalar.
   Sin OpenCV: casco de Andrew + calibradores para el rectángulo mínimo; el
   offset del unclip es exacto para quads convexos. */

/** Umbral de binarizado del mapa (PostProcess.thresh del inference.yml). */
export const DB_UMBRAL_BIN: number = 0.2;
/** Puntaje mínimo de caja (PostProcess.box_thresh del inference.yml). */
export const DB_UMBRAL_CAJA: number = 0.45;
/** Tope de componentes (PostProcess.max_candidates del inference.yml). */
export const DB_MAX_CAJAS: number = 3000;
/** Expansión del unclip (PostProcess.unclip_ratio del inference.yml). */
export const DB_UNCLIP: number = 1.4;
/** Área mínima en px de entrada (guarda degenerados; Python los conserva). */
const AREA_MINIMA_CAJA = 4;

/** Punto 2D en píxeles (coordenadas de mapa o de entrada según contexto). */
export type PuntoDb = readonly [x: number, y: number];

/** Caja de texto: quad ordenado (sup-izq, sup-der, inf-der, inf-izq) + puntaje. */
export interface CajaDb {
  readonly poli: readonly [PuntoDb, PuntoDb, PuntoDb, PuntoDb];
  readonly puntaje: number;
}

/** Tamaño de la imagen de entrada al detector (para reescalar las cajas). */
export interface TamanoDb {
  readonly ancho: number;
  readonly alto: number;
}

/** Binariza el mapa de probabilidad (1 = texto). Con borde cero de 1px. */
export function binarizarMapa(
  mapa: Float32Array,
  ancho: number,
  alto: number,
  umbral: number = DB_UMBRAL_BIN,
): Uint8Array {
  const w = ancho + 2;
  const h = alto + 2;
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < alto; y += 1) {
    for (let x = 0; x < ancho; x += 1) {
      bin[(y + 1) * w + x + 1] = (mapa[y * ancho + x] ?? 0) > umbral ? 1 : 0;
    }
  }
  return bin;
}

/** Expande los 8 vecinos calientes sin marcar (muta marca/pila). */
function empujarVecinos(
  bin: Uint8Array,
  ancho: number,
  marca: Uint32Array,
  x: number,
  y: number,
  etiqueta: number,
  pila: number[],
): void {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const q = (y + dy) * ancho + (x + dx);
      // ponytail: marca[q] sin ?? (si q es OOB, bin[q] ya cortó a la izquierda).
      if ((bin[q] ?? 0) === 1 && marca[q] === 0) {
        marca[q] = etiqueta;
        pila.push(q);
      }
    }
  }
}

/** Marca el componente conexo (8-vecinos) y devuelve sus píxeles (coords de mapa). */
export function inundar(
  bin: Uint8Array,
  ancho: number,
  marca: Uint32Array,
  sx: number,
  sy: number,
  etiqueta: number,
): PuntoDb[] {
  const puntos: PuntoDb[] = [];
  const pila: number[] = [sy * ancho + sx];
  marca[sy * ancho + sx] = etiqueta;
  while (pila.length > 0) {
    const p = pila.pop() ?? 0;
    const x = p % ancho;
    const y = (p - x) / ancho;
    puntos.push([x - 1, y - 1]);
    empujarVecinos(bin, ancho, marca, x, y, etiqueta, pila);
  }
  return puntos;
}

/** Producto cruzado OA × OB. */
function cruz(o: PuntoDb, a: PuntoDb, b: PuntoDb): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Sin duplicados consecutivos (el sort los agrupa). */
function sinDuplicados(pts: PuntoDb[]): PuntoDb[] {
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]?.[0] || p[1] !== pts[i - 1]?.[1]);
}

/** Una cadena del casco (delReves = superior): monotone chain con poda. */
function cadenaCasco(unicos: readonly PuntoDb[], delReves: boolean): PuntoDb[] {
  const cadena: PuntoDb[] = [];
  const n = unicos.length;
  for (let k = 0; k < n; k += 1) {
    // ponytail: k < n en ambas direcciones.
    const p = unicos[delReves ? n - 1 - k : k] as PuntoDb;
    while (
      cadena.length >= 2 &&
      cruz(cadena[cadena.length - 2] as PuntoDb, cadena[cadena.length - 1] as PuntoDb, p) <= 0
    ) {
      cadena.pop();
    }
    cadena.push(p);
  }
  cadena.pop();
  return cadena;
}

/** Casco convexo de Andrew (monotone chain), sin duplicar el cierre. */
export function cascoConvexo(puntos: readonly PuntoDb[]): PuntoDb[] {
  const pts = [...puntos].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unicos = sinDuplicados(pts);
  if (unicos.length < 3) return unicos;
  return [...cadenaCasco(unicos, false), ...cadenaCasco(unicos, true)];
}

/** Área con signo (shoelace); negativa = horario. */
export function areaDoble(poli: readonly PuntoDb[]): number {
  let a = 0;
  for (let i = 0; i < poli.length; i += 1) {
    const p = poli[i] ?? [0, 0];
    const q = poli[(i + 1) % poli.length] ?? [0, 0];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/** Proyección del casco sobre (ux,uy): min/max en u y v. */
export function proyectarCasco(
  casco: readonly PuntoDb[],
  ux: number,
  uy: number,
): { minU: number; maxU: number; minV: number; maxV: number } {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of casco) {
    const u = p[0] * ux + p[1] * uy;
    const v = -p[0] * uy + p[1] * ux;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  return { minU, maxU, minV, maxV };
}

/**
 * Rectángulo de área mínima por calibradores rotativos sobre el casco.
 * Devuelve null si es degenerado (<3 puntos de casco).
 */
export function rectanguloMinimo(casco: readonly PuntoDb[]): CajaDb["poli"] | null {
  if (casco.length < 3) return null;
  let mejor: CajaDb["poli"] | null = null;
  let mejorArea = Infinity;
  const n = casco.length;
  for (let i = 0; i < n; i += 1) {
    const a = casco[i] ?? [0, 0];
    const b = casco[(i + 1) % n] ?? [0, 0];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const mod = Math.hypot(dx, dy);
    if (mod === 0) continue;
    const ux = dx / mod;
    const uy = dy / mod;
    const { minU, maxU, minV, maxV } = proyectarCasco(casco, ux, uy);
    const area = (maxU - minU) * (maxV - minV);
    if (area < mejorArea) {
      mejorArea = area;
      const esquina = (u: number, v: number): PuntoDb => [u * ux - v * uy, u * uy + v * ux];
      mejor = [esquina(minU, minV), esquina(maxU, minV), esquina(maxU, maxV), esquina(minU, maxV)];
    }
  }
  return mejor;
}

/** Ordena el quad: sup-izq, sup-der, inf-der, inf-izq. */
export function ordenarQuad(poli: CajaDb["poli"]): CajaDb["poli"] {
  const [p0, p1, p2, p3] = poli;
  const porX = [p0, p1, p2, p3].sort((a, b) => a[0] - b[0]);
  const izq = porX.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const der = porX.slice(2).sort((a, b) => a[1] - b[1]);
  return [izq[0] ?? p0, der[0] ?? p1, der[1] ?? p2, izq[1] ?? p3];
}

/** True si (x,y) está dentro del quad convexo (vale con cualquier enrollado). */
export function puntoEnQuad(poli: CajaDb["poli"], x: number, y: number, horario: boolean): boolean {
  for (let i = 0; i < 4; i += 1) {
    const a = poli[i] ?? [0, 0];
    const b = poli[(i + 1) % 4] ?? [0, 0];
    const c = cruz(a, b, [x, y]);
    if (horario ? c > 0 : c < 0) return false;
  }
  return true;
}

/** Media del mapa dentro del quad convexo (box_score_fast de PaddleOCR). */
export function puntuarCaja(mapa: Float32Array, anchoMapa: number, poli: CajaDb["poli"]): number {
  const xs = poli.map((p) => p[0]);
  const ys = poli.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(anchoMapa - 1, Math.ceil(Math.max(...xs)));
  const altoMapa = Math.floor(mapa.length / anchoMapa);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(altoMapa - 1, Math.ceil(Math.max(...ys)));
  const horario = areaDoble(poli) < 0;
  let suma = 0;
  let n = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (puntoEnQuad(poli, x, y, horario)) {
        suma += mapa[y * anchoMapa + x] ?? 0;
        n += 1;
      }
    }
  }
  return n > 0 ? suma / n : 0;
}

/** Perímetro del quad. */
function perimetro(poli: CajaDb["poli"]): number {
  let p = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = poli[i] ?? [0, 0];
    const b = poli[(i + 1) % 4] ?? [0, 0];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

/** Recta offset (normal unitaria + término): el cruce de vecinas da el vértice. */
export interface RectaOffset {
  readonly nx: number;
  readonly ny: number;
  readonly c: number;
}

/** Recta desplazada de una arista (null si degenerada). */
export function rectaDesplazada(
  a: PuntoDb,
  b: PuntoDb,
  gx: number,
  gy: number,
  d: number,
): RectaOffset | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const mod = Math.hypot(dx, dy);
  if (mod === 0) return null;
  let nx = dy / mod;
  let ny = -dx / mod;
  const mx = (a[0] + b[0]) / 2 - gx;
  const my = (a[1] + b[1]) / 2 - gy;
  const prod = nx * mx + ny * my;
  if (prod < 0) {
    nx = -nx;
    ny = -ny;
  } else if (prod === 0) {
    return null;
  }
  return { nx, ny, c: nx * (a[0] + nx * d) + ny * (a[1] + ny * d) };
}

/** Intersección de dos rectas offset (null si paralelas). */
export function interseccionRectas(r1: RectaOffset, r2: RectaOffset): PuntoDb | null {
  const det = r1.nx * r2.ny - r2.nx * r1.ny;
  if (Math.abs(det) < 1e-9) return null;
  return [(r1.c * r2.ny - r2.c * r1.ny) / det, (r1.nx * r2.c - r2.nx * r1.c) / det];
}

/**
 * Expande el quad convexo desplazando cada arista hacia fuera una distancia
 * d = área·ratio/perímetro e intersecando rectas vecinas (offset exacto de
 * PaddleOCR/clipper para quads convexos, sin la dependencia).
 * La normal se orienta con el centroide: vale con cualquier enrollado.
 */
export function expandirQuad(
  poli: CajaDb["poli"],
  ratio: number = DB_UNCLIP,
): CajaDb["poli"] | null {
  const gx = (poli[0][0] + poli[1][0] + poli[2][0] + poli[3][0]) / 4;
  const gy = (poli[0][1] + poli[1][1] + poli[2][1] + poli[3][1]) / 4;
  const area = Math.abs(areaDoble(poli)) / 2;
  const per = perimetro(poli);
  if (per <= 0 || area <= 0) return null;
  const d = (area * ratio) / per;
  const rectas = poli.map((a, i) => {
    // ponytail: poli es tupla de 4.
    const b = poli[(i + 1) % 4] as PuntoDb;
    return rectaDesplazada(a, b, gx, gy, d);
  });
  if (rectas.some((r) => r === null)) return null;
  const fuera: PuntoDb[] = [];
  for (let i = 0; i < 4; i += 1) {
    // ponytail: map de 4.
    const r1 = rectas[(i + 3) % 4] as RectaOffset;
    const r2 = rectas[i] as RectaOffset;
    const p = interseccionRectas(r1, r2);
    if (!p) return null;
    fuera.push(p);
  }
  // ponytail: 4 intersecciones (la única salida es el return).
  return [fuera[0] as PuntoDb, fuera[1] as PuntoDb, fuera[2] as PuntoDb, fuera[3] as PuntoDb];
}

/**
 * Mapa de probabilidad → cajas en coordenadas de la imagen de entrada.
 * Recorre componentes en orden de scan (determinista); nunca lanza.
 */
export function cajasDesdeMapa(
  mapa: Float32Array,
  anchoMapa: number,
  altoMapa: number,
  origen: TamanoDb,
): CajaDb[] {
  const cajas: CajaDb[] = [];
  try {
    if (anchoMapa < 1 || altoMapa < 1 || origen.ancho < 1 || origen.alto < 1) return cajas;
    if (mapa.length < anchoMapa * altoMapa) return cajas;
    const w = anchoMapa + 2;
    const h = altoMapa + 2;
    const bin = binarizarMapa(mapa, anchoMapa, altoMapa);
    // ponytail: Uint32 (un mapa con ruido puede superar las 65k componentes del Uint16).
    const marca = new Uint32Array(w * h);
    barrerMapa(bin, w, mapa, anchoMapa, altoMapa, marca, origen, cajas);
  } catch {
    return cajas;
  }
  return cajas;
}

/** Procesa una celda caliente: componente → caja escalada (null si se descarta). */
function cajaEnCelda(
  bin: Uint8Array,
  w: number,
  marca: Uint32Array,
  x: number,
  y: number,
  mapa: Float32Array,
  anchoMapa: number,
  altoMapa: number,
  etiqueta: number,
  origen: TamanoDb,
): CajaDb | null {
  const pixeles = inundar(bin, w, marca, x, y, etiqueta);
  if (pixeles.length < 3) return null; // puntito sin área
  const mini = rectanguloMinimo(cascoConvexo(pixeles));
  if (!mini) return null;
  const puntaje = puntuarCaja(mapa, anchoMapa, mini);
  if (puntaje < DB_UMBRAL_CAJA) return null;
  const grande = expandirQuad(ordenarQuad(mini));
  if (!grande) return null;
  const escX = origen.ancho / anchoMapa;
  const escY = origen.alto / altoMapa;
  const esc = grande.map(
    ([cx, cy]) =>
      [
        Math.min(origen.ancho, Math.max(0, cx * escX)),
        Math.min(origen.alto, Math.max(0, cy * escY)),
      ] as PuntoDb,
  );
  // ponytail: map de 4 (grande es tupla) y sin 2º ordenarQuad
  // (el reescalado monótono no reordena).
  const poli: CajaDb["poli"] = [
    esc[0] as PuntoDb,
    esc[1] as PuntoDb,
    esc[2] as PuntoDb,
    esc[3] as PuntoDb,
  ];
  // ponytail: shoelace (la fórmula anterior daba 0 en quads rotados).
  if (Math.abs(areaDoble(poli)) / 2 < AREA_MINIMA_CAJA) return null;
  return { poli, puntaje };
}

/** Barre el mapa en orden de scan y acumula cajas (muta marca/cajas). */
function barrerMapa(
  bin: Uint8Array,
  w: number,
  mapa: Float32Array,
  anchoMapa: number,
  altoMapa: number,
  marca: Uint32Array,
  origen: TamanoDb,
  cajas: CajaDb[],
): void {
  let etiqueta = 0;
  for (let y = 1; y <= altoMapa && cajas.length < DB_MAX_CAJAS; y += 1) {
    for (let x = 1; x <= anchoMapa && cajas.length < DB_MAX_CAJAS; x += 1) {
      const p = y * w + x;
      if (bin[p] !== 1 || marca[p] !== 0) continue;
      etiqueta += 1;
      const caja = cajaEnCelda(bin, w, marca, x, y, mapa, anchoMapa, altoMapa, etiqueta, origen);
      if (caja) cajas.push(caja);
    }
  }
}
