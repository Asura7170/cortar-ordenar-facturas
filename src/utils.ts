/* Utilidades compartidas (hojas del grafo: sin dependencias internas). */

/** getElementById que falla fuerte si falta el id (el HTML es contrato). */
export function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta #${id} en index.html`);
  return el as T;
}

/** Sanea entrada del usuario (nombres de archivo, texto OCR) antes del DOM. */
export function sanear(s: unknown): string {
  // ponytail: solo string/number llegan al DOM; objetos → "" (nunca "[object Object]").
  return (typeof s === "string" ? s : typeof s === "number" ? String(s) : "").toWellFormed();
}
