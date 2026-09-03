/* Factorías para tests (evitan repetir los 11 campos del comprobante). */
import { nextComprobanteId } from '../state';
import type { Comprobante } from '../types';

export function comprobante(parc?: Partial<Comprobante>): Comprobante {
  return {
    id: nextComprobanteId(),
    nombre: 'factura.png',
    imgUrl: 'blob:mock-1',
    thumbUrl: null,
    textoOcr: '',
    montoCents: null,
    moneda: 'USD',
    estado: 'pendiente',
    posicion: 0,
    ...parc,
  };
}

export function archivo(nombre: string, type: string): File {
  return new File(['x'], nombre, { type });
}
