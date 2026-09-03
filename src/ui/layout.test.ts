/* Tests P0: plantillas de distribución (sin DOM). */
import { describe, expect, it } from 'vitest';
import { NOMBRES_LAYOUT, ORDEN_PLANTILLAS, PLANTILLAS, isLayoutId, layoutDe } from './layout';
import type { LayoutId } from '../types';

const TOTALES: Record<LayoutId, number> = {
  u1: 1, u2h: 2, u2v: 2, u3h: 3, u3v: 3, u3m: 3, u4x2: 4, u5m: 5, u6x2: 6, u6m: 6,
};

describe('PLANTILLAS', () => {
  it.each(Object.keys(TOTALES) as LayoutId[])('%s tiene su total', (id) => {
    expect(PLANTILLAS[id].total).toBe(TOTALES[id]);
  });

  it('cada plantilla define una posición por casilla', () => {
    for (const id of Object.keys(TOTALES) as LayoutId[]) {
      expect(PLANTILLAS[id].pos).toHaveLength(PLANTILLAS[id].total);
    }
  });

  it('ORDEN_PLANTILLAS trae las 10 y NOMBRES las nombra a todas', () => {
    expect(ORDEN_PLANTILLAS).toHaveLength(10);
    for (const id of Object.keys(TOTALES) as LayoutId[]) {
      expect(ORDEN_PLANTILLAS).toContain(id);
      expect(NOMBRES_LAYOUT[id]).toBeTruthy();
    }
  });
});

describe('isLayoutId / layoutDe', () => {
  it('isLayoutId valida conocidos y rechaza el resto', () => {
    expect(isLayoutId('u4x2')).toBe(true);
    expect(isLayoutId('bogus')).toBe(false);
    expect(isLayoutId('')).toBe(false);
  });

  it('layoutDe devuelve la plantilla pedida', () => {
    expect(layoutDe('u1')).toBe(PLANTILLAS.u1);
  });

  it('layoutDe desconocido cae a u4x2 sin tirar', () => {
    expect(layoutDe('bogus')).toBe(PLANTILLAS.u4x2);
  });
});
