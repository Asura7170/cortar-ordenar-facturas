/* Utilidades compartidas (hojas del grafo: sin dependencias internas). */

/** getElementById que falla fuerte si falta el id (el HTML es contrato). */
export function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta #${id} en index.html`);
  return el as T;
}

/** Sanea entrada del usuario (nombres de archivo, texto OCR) antes del DOM. */
export function sanear(s: unknown): string {
  return String(s ?? "").toWellFormed();
}

/** sleep cancelable por AbortSignal (Chrome 119+). */
export function sleep(ms: number, opts?: { signal?: AbortSignal }): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const signal = opts?.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(t);
      resolve();
    },
    { once: true },
  );
  return promise;
}
