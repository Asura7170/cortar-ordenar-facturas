/* Admisión de PDF: un PDF entra solo si pesa ≤ 5 MB y tiene ≤ 10 páginas.
   El tamaño se chequea sincrónico; las páginas requieren abrir el documento
   (pdf.js vía import dinámico: solo se descarga cuando llega un PDF).
   Todo rechazo se avisa y se descarta sin crear comprobante ni blob URL. */
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import { CALIDAD_JPEG, esPaginaBlanca } from "./imagen";

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
  // ponytail: respeta workerSrc ya configurado (tests fijan file:// local).
  pdfjs.GlobalWorkerOptions.workerSrc ||= workerSrc;
  // Vista propia (no copia en Chrome): blinda Buffer/vistas raras de arrayBuffer().
  const datos: Uint8Array = new Uint8Array(await f.arrayBuffer());
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

/** Ancho fijo del render por página (≈2× la celda u4x2: nítido en 1x y 2x). */
const ANCHO_MINI_PDF = 720;

/** Página útil de un PDF: índice 1-based, total del documento y su imagen WebP. */
export interface PaginaPdf {
  readonly indice: number;
  readonly total: number;
  readonly blob: Blob;
}

/** Documento abierto: total + render por página + cierre (seam inyectable). */
export interface DocumentoPdf {
  readonly total: number;
  readonly renderizar: (indice: number) => Promise<HTMLCanvasElement | null>;
  readonly cerrar: () => Promise<void>;
}

/** Lienzo seguro: un MediaBox extremo (p.ej. 1pt de ancho) daría un lienzo gigante que cuelga la pestaña. */
// ponytail: umbrales fijos (alto ≤4000, área ≤8M px); afinar si hay facturas legítimas fuera.
export function vistaSegura(ancho: number, alto: number): boolean {
  return (
    Number.isFinite(ancho) &&
    Number.isFinite(alto) &&
    ancho >= 1 &&
    alto >= 1 &&
    alto <= 4000 &&
    ancho * alto <= 8_000_000
  );
}

/** Apertura real con pdf.js (import dinámico: solo se descarga con PDFs). */
async function abrirPdfReal(f: File): Promise<DocumentoPdf> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc ||= workerSrc;
  const datos: Uint8Array = new Uint8Array(await f.arrayBuffer());
  const tarea = pdfjs.getDocument({ data: datos });
  const doc = await tarea.promise;
  return {
    total: doc.numPages,
    renderizar: async (indice: number): Promise<HTMLCanvasElement | null> => {
      const pagina = await doc.getPage(indice);
      const base = pagina.getViewport({ scale: 1 });
      if (!vistaSegura(base.width, base.height)) return null;
      const escala = ANCHO_MINI_PDF / base.width;
      const vista = pagina.getViewport({ scale: escala });
      if (!vistaSegura(vista.width, vista.height)) return null;
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.max(1, Math.round(vista.width));
      lienzo.height = Math.max(1, Math.round(vista.height));
      const ctx = lienzo.getContext("2d");
      if (!ctx) return null;
      await pagina.render({ canvasContext: ctx, canvas: lienzo, viewport: vista }).promise;
      return lienzo;
    },
    cerrar: async (): Promise<void> => {
      await tarea.destroy();
    },
  };
}

/** Apertura inyectable: el llamador pasa la real; los tests, un stub. */
export type AbrirPdf = (f: File) => Promise<DocumentoPdf>;

// Detección de página vacía (vive en imagen.ts: vale para PDF e intake).
export { esPaginaBlanca } from "./imagen";

/**
 * Fan-out: cada página no-blanca → una PaginaPdf (un render por página,
 * apertura única, un destroy). Nunca lanza: lo ilegible da [].
 * El llamador avisa "no se pudo leer" si vuelve vacío.
 */
export async function expandirPdf(f: File, abrir: AbrirPdf = abrirPdfReal): Promise<PaginaPdf[]> {
  const utiles: PaginaPdf[] = [];
  let doc: DocumentoPdf | null = null;
  try {
    if (!admiteTamanoPdf(f)) return utiles;
    doc = await abrir(f);
    const total = doc.total;
    if (total < 1 || total > PDF_MAX_PAGINAS) return utiles;
    // ponytail: secuencial a propósito; N renders en paralelo saturan memoria.
    for (let i = 1; i <= total; i++) {
      try {
        const lienzo = await doc.renderizar(i);
        if (!lienzo || esPaginaBlanca(lienzo)) continue;
        const blob = await new Promise<Blob | null>((res) =>
          lienzo.toBlob(res, "image/jpeg", CALIDAD_JPEG),
        );
        if (blob) utiles.push({ indice: i, total, blob });
      } catch {
        continue; // ponytail: página mala no tumba a las hermanas
      }
    }
  } catch {
    return utiles;
  } finally {
    try {
      await doc?.cerrar();
    } catch {
      // ponytail: destroy best-effort; el worker muere con la página
    }
  }
  return utiles;
}
