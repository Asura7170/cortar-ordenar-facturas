/* Plantillas de distribución N-up (la mini-vista replica esta grilla). */
import type { LayoutId, Plantilla } from "../types";

export const PLANTILLAS: Record<LayoutId, Plantilla> = {
  u1: { total: 1, filas: 1, cols: 2, pos: [[1, 1, 2]] },
  u2h: {
    total: 2,
    filas: 1,
    cols: 2,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
    ],
  },
  u2v: {
    total: 2,
    filas: 2,
    cols: 1,
    pos: [
      [1, 1, 1],
      [2, 1, 1],
    ],
  },
  u3h: {
    total: 3,
    filas: 1,
    cols: 3,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
      [1, 3, 1],
    ],
  },
  u3v: {
    total: 3,
    filas: 3,
    cols: 1,
    pos: [
      [1, 1, 1],
      [2, 1, 1],
      [3, 1, 1],
    ],
  },
  u3m: {
    total: 3,
    filas: 2,
    cols: 2,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
      [2, 1, 2],
    ],
  },
  u4x2: {
    total: 4,
    filas: 2,
    cols: 2,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
      [2, 1, 1],
      [2, 2, 1],
    ],
  },
  u5m: {
    total: 5,
    filas: 2,
    cols: 6,
    pos: [
      [1, 1, 2],
      [1, 3, 2],
      [1, 5, 2],
      [2, 2, 2],
      [2, 4, 2],
    ],
  },
  u6x2: {
    total: 6,
    filas: 2,
    cols: 3,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
      [1, 3, 1],
      [2, 1, 1],
      [2, 2, 1],
      [2, 3, 1],
    ],
  },
  u6m: {
    total: 6,
    filas: 3,
    cols: 2,
    pos: [
      [1, 1, 1],
      [1, 2, 1],
      [2, 1, 1],
      [2, 2, 1],
      [3, 1, 1],
      [3, 2, 1],
    ],
  },
};

export const NOMBRES_LAYOUT: Record<LayoutId, string> = {
  u1: "1 · Centrado",
  u2h: "2 · Fila",
  u2v: "2 · Columna",
  u3h: "3 · Fila",
  u3v: "3 · Columna",
  u3m: "3 · 2+1",
  u4x2: "4 · Cuadrado",
  u5m: "5 · 3+2",
  u6x2: "6 · 3×2",
  u6m: "6 · 2+2+2",
};

// Orden de presentación en el panel (agrupado por cantidad de comprobantes).
export const ORDEN_PLANTILLAS: readonly LayoutId[] = [
  "u1",
  "u2h",
  "u2v",
  "u3h",
  "u3v",
  "u3m",
  "u4x2",
  "u5m",
  "u6x2",
  "u6m",
];

export function isLayoutId(id: string): id is LayoutId {
  return (ORDEN_PLANTILLAS as readonly string[]).includes(id);
}

export function layoutDe(id: string): Plantilla {
  if (isLayoutId(id)) return PLANTILLAS[id];
  return PLANTILLAS.u4x2;
}
