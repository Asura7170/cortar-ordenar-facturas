/* Admisión de PDF: un PDF entra solo si pesa ≤ 5 MB y tiene ≤ 10 páginas.
   El tamaño se chequea sincrónico; las páginas requieren abrir el documento
   (pdf.js vía import dinámico: solo se descarga cuando llega un PDF).
   Todo rechazo se avisa y se descarta sin crear comprobante ni blob URL. */
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

/** Tope de tamaño por PDF (5 MiB, inclusivo). */
export const PDF_MAX_BYTES: number = 5 * 1024 * 1024;

/** Tope de páginas por PDF (inclusivo: 10 entra, 11 no). */
export const PDF_MAX_PAGINAS: number = 10;

/** Por qué se rechazó un PDF (para el aviso). */
export type MotivoRechazo = "tamano" | "paginas" | "cifrado" | "ilegible";

/** Veredicto de admisión de un PDF. */
export type VeredictoPdf =
  | { readonly admite: true }
  | { readonly admite: false; readonly motivo: MotivoRechazo };

/** Es PDF por MIME o por extensión (no se exige type exacto: Explorer/Chrome
    suelen reportar application/octet-stream). */
export function esPdf(f: File): boolean {
  return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
}

/** Chequeo sincrónico de tamaño (inclusivo; 0 bytes no admite). */
export function admiteTamanoPdf(f: File, limite: number = PDF_MAX_BYTES): boolean {
  return f.size > 0 && f.size <= limite;
}

/** Contador de páginas (seam inyectable: los tests lo stubban, jsdom no abre PDF). */
export type ContadorPaginas = (f: File) => Promise<number>;

/** Cuenta las páginas abriendo el documento con pdf.js. Lanza si es
    ilegible o cifrado (no captura: clasifica admitirPdf). */
export async function contarPaginasPdf(f: File): Promise<number> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const datos: ArrayBuffer = await f.arrayBuffer();
  const tarea = pdfjs.getDocument({ data: datos });
  const doc = await tarea.promise;
  try {
    return doc.numPages;
  } finally {
    await tarea.destroy();
  }
}

function esPassword(e: unknown): boolean {
  return e instanceof Error && e.name === "PasswordException";
}

/** Gate completo: tamaño (sync) y luego páginas (async). Nunca lanza.
    El contador se inyecta (el llamador pasa el real; los tests, un stub). */
export async function admitirPdf(f: File, contar: ContadorPaginas): Promise<VeredictoPdf> {
  if (f.size === 0) return { admite: false, motivo: "ilegible" };
  if (!admiteTamanoPdf(f)) return { admite: false, motivo: "tamano" };
  let paginas: number;
  try {
    paginas = await contar(f);
  } catch (e: unknown) {
    return { admite: false, motivo: esPassword(e) ? "cifrado" : "ilegible" };
  }
  return paginas <= PDF_MAX_PAGINAS ? { admite: true } : { admite: false, motivo: "paginas" };
}

/** Ancho fijo de la miniatura (≈2× la celda u4x2: nítida en 1x y 2x). */
const ANCHO_MINI_PDF = 720;

/**
 * Miniatura WebP de la primera página; null si no rasterizable.
 * Apertura única: cuenta y renderiza con el mismo documento (sin reabrir).
 * Nunca lanza: si algo falla, la celda usa el fallback actual.
 */
export async function generarMiniaturaPdf(f: File): Promise<string | null> {
  try {
    if (!admiteTamanoPdf(f)) return null;
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    const datos: ArrayBuffer = await f.arrayBuffer();
    const tarea = pdfjs.getDocument({ data: datos });
    const doc = await tarea.promise;
    try {
      if (doc.numPages < 1 || doc.numPages > PDF_MAX_PAGINAS) return null;
      const pagina = await doc.getPage(1);
      const escala = ANCHO_MINI_PDF / pagina.getViewport({ scale: 1 }).width;
      const vista = pagina.getViewport({ scale: escala });
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.max(1, Math.round(vista.width));
      lienzo.height = Math.max(1, Math.round(vista.height));
      const ctx = lienzo.getContext("2d");
      if (!ctx) return null;
      await pagina.render({ canvasContext: ctx, canvas: lienzo, viewport: vista }).promise;
      const blob = await new Promise<Blob | null>((res) => lienzo.toBlob(res, "image/webp", 0.82));
      return blob ? URL.createObjectURL(blob) : null;
    } finally {
      await tarea.destroy();
    }
  } catch {
    return null;
  }
}
