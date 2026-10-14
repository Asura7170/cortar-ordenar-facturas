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

/** Aviso de error en #aviso: el texto va en span.motivo (rojo sello, el
    styling del rechazo de sidebar) — ya no texto plano gris. Sin #aviso, no-op. */
export function avisarError(texto: string): void {
  // ponytail: vive aquí — recorte y sheets ya importan utils; un módulo nuevo
  // en src/ui sería diff muerto y arriesga un ciclo de imports.
  const el = document.getElementById("aviso");
  if (!el) return;
  const motivo = document.createElement("span");
  motivo.className = "motivo";
  motivo.textContent = texto;
  el.replaceChildren(motivo);
}
