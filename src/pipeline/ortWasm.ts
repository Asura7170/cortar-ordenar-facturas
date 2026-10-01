/** Versión ORT única (ort-bump la reescribe; su grep la amarra a package.json). */
export const VERSION_ORT = "1.30.0";

/** wasmPaths: CDN pineado en PROD (25.5MB > límite Pages), local en dev. Siempre con trailing /. */
export function rutaWasmOrt(prod: boolean, base: string): string {
  return prod ? `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VERSION_ORT}/dist/` : `${base}ort/`;
}
