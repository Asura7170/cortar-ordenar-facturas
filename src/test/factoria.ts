/* Factorías para tests (evitan repetir los campos del comprobante). */
import { nextComprobanteId } from "../state";
import type { Comprobante } from "../types";

export function comprobante(parc?: Partial<Comprobante>): Comprobante {
  return {
    id: nextComprobanteId(),
    nombre: "factura.png",
    imgUrl: "blob:mock-1",
    textoOcr: "",
    montoCents: null,
    montoManual: false,
    moneda: "USD",
    estado: "pendiente",
    posicion: 0,
    ...parc,
  };
}

export function archivo(nombre: string, type: string): File {
  return new File(["x"], nombre, { type });
}
