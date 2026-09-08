/* Salidas Word (.docx real vía docx) + PDF/Imprimir (avisan: espec, sin implementar).
   Una sola fuente (state.hojas + layout + codigoPosicion) y un solo gate. */
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HorizontalPositionRelativeFrom,
  ImageRun,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  convertInchesToTwip,
} from "docx";
import { state } from "../state";
import type { Comprobante, Hoja, LayoutId, PosicionCodigo } from "../types";
import { layoutDe } from "../ui/layout";
import { totalItems } from "../ui/monto";
import { getEl } from "../utils";

const btnDescargar: HTMLButtonElement = getEl<HTMLButtonElement>("btnDescargar2");
const btnPdf: HTMLButtonElement = getEl<HTMLButtonElement>("btnPdf");
const btnImprimir: HTMLButtonElement = getEl<HTMLButtonElement>("btnImprimir");
const zonaPrint: HTMLElement = getEl<HTMLElement>("zonaPrint");

/** Carta 8.5×11"; margen 0.3" + banda 0.3" del lado del código (nunca se pisan). */
const ANCHO_CARTA = 8.5;
const ALTO_CARTA = 11;
const MARGEN = 0.3;
const BANDA_CODIGO = 0.3;
/** Calle entre imágenes vecinas (el rect de cada casilla se encoge GUTTER/2 por lado). */
export const GUTTER = 0.15;
/** 1" = 914400 EMU (offsets); transformation en px @96dpi → 1px = 9525 EMU. */
const EMU_POR_PULGADA = 914400;
const EMU_POR_PX = 9525;

export function codigoValido(): boolean {
  if (!state.codigoActivo) return true;
  return state.codigoValor.length === state.codigoLongitud && /^\d+$/.test(state.codigoValor);
}

export function nombreArchivo(ext: string = "docx"): string {
  const cod = state.codigoActivo ? state.codigoValor : "sincodigo";
  return `${cod}-comprobante.${ext}`;
}

/** Rectángulo en EMU relativo a la esquina de la página. */
export interface RectEmu {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Un rect por casilla de la plantilla (orden de slots), con la banda del código libre. */
export function geometria(layout: LayoutId, posicion: PosicionCodigo): RectEmu[] {
  const p = layoutDe(layout);
  const arriba = posicion.startsWith("sup") ? MARGEN + BANDA_CODIGO : MARGEN;
  const abajo = posicion.startsWith("inf") ? MARGEN + BANDA_CODIGO : MARGEN;
  const celdaW = (ANCHO_CARTA - MARGEN * 2) / p.cols;
  const celdaH = (ALTO_CARTA - arriba - abajo) / p.filas;
  const mediaCalle = Math.round((GUTTER / 2) * EMU_POR_PULGADA);
  const calle = mediaCalle * 2;
  return p.pos.map(([fila, col, span]) => ({
    x: Math.round((MARGEN + (col - 1) * celdaW) * EMU_POR_PULGADA) + mediaCalle,
    y: Math.round((arriba + (fila - 1) * celdaH) * EMU_POR_PULGADA) + mediaCalle,
    w: Math.max(1, Math.round(span * celdaW * EMU_POR_PULGADA) - calle),
    h: Math.max(1, Math.round(celdaH * EMU_POR_PULGADA) - calle),
  }));
}

/** Encaja (ancho,alto) en el rect conservando proporción; px enteros ≥1. */
export function encajar(
  ancho: number,
  alto: number,
  rect: RectEmu,
): { readonly w: number; readonly h: number } {
  const rectW = Math.max(1, Math.round(rect.w / EMU_POR_PX));
  const rectH = Math.max(1, Math.round(rect.h / EMU_POR_PX));
  if (ancho < 1 || alto < 1) return { w: rectW, h: rectH };
  const escala = Math.min(rectW / ancho, rectH / alto);
  return { w: Math.max(1, Math.floor(ancho * escala)), h: Math.max(1, Math.floor(alto * escala)) };
}

/** Dimensiones del blob sin mostrarlo (cierra el bitmap). */
export async function medirImagen(blob: Blob): Promise<{ readonly w: number; readonly h: number }> {
  const bmp = await createImageBitmap(blob);
  const dims = { w: bmp.width, h: bmp.height };
  bmp.close();
  return dims;
}

// ponytail: blobDe local (6 líneas); importar queue.ts arrastraría onnxruntime a este módulo y sus tests.
/** Blob full-res del comprobante (nunca el thumb): file, o el imgUrl local. */
async function blobDe(c: Comprobante): Promise<Blob> {
  if (c.file) return c.file;
  return await (await fetch(c.imgUrl)).blob();
}

function parrafoCodigo(codigo: string, posicion: PosicionCodigo): Paragraph {
  const alinear = posicion.endsWith("der") ? AlignmentType.RIGHT : AlignmentType.LEFT;
  return new Paragraph({
    alignment: alinear,
    children: [new TextRun({ text: codigo, size: 20 })],
  });
}

/** Párrafo con las imágenes flotantes de una hoja (offsets PAGE absolutos). */
async function parrafoHoja(hoja: Hoja, posicion: PosicionCodigo): Promise<Paragraph> {
  const rects = geometria(hoja.layout, posicion);
  const runs: ImageRun[] = [];
  for (let i = 0; i < hoja.slots.length; i++) {
    const item = hoja.slots[i];
    const rect = rects[i];
    if (!item || !rect) continue;
    const blob = await blobDe(item);
    const dims = await medirImagen(blob);
    const t = encajar(dims.w, dims.h, rect);
    runs.push(
      new ImageRun({
        type: "jpg",
        data: await blob.arrayBuffer(),
        transformation: { width: t.w, height: t.h },
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.PAGE,
            offset: rect.x + Math.round((rect.w - t.w * EMU_POR_PX) / 2),
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: rect.y + Math.round((rect.h - t.h * EMU_POR_PX) / 2),
          },
          allowOverlap: true,
          wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES },
        },
      }),
    );
  }
  return new Paragraph({ children: runs });
}

/** Arma el .docx: 1 sección carta + header/footer del código + 1 párrafo por hoja. */
export async function construirDocumento(
  hojas: readonly Hoja[],
  codigo: string,
  posicion: PosicionCodigo,
): Promise<Document> {
  const supra = posicion.startsWith("sup");
  const hijos: Paragraph[] = [];
  for (const hoja of hojas) {
    if (hijos.length > 0) hijos.push(new Paragraph({ children: [new PageBreak()] }));
    hijos.push(await parrafoHoja(hoja, posicion));
  }
  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertInchesToTwip(ANCHO_CARTA),
              height: convertInchesToTwip(ALTO_CARTA),
              orientation: PageOrientation.PORTRAIT,
            },
            margin: {
              top: convertInchesToTwip(supra ? MARGEN + BANDA_CODIGO : MARGEN),
              right: convertInchesToTwip(MARGEN),
              bottom: convertInchesToTwip(supra ? MARGEN : MARGEN + BANDA_CODIGO),
              left: convertInchesToTwip(MARGEN),
              header: convertInchesToTwip(MARGEN),
              footer: convertInchesToTwip(MARGEN),
            },
          },
        },
        // Sin código no hay banda que rotular: se omite el elemento.
        ...(codigo === ""
          ? {}
          : supra
            ? { headers: { default: new Header({ children: [parrafoCodigo(codigo, posicion)] }) } }
            : {
                footers: { default: new Footer({ children: [parrafoCodigo(codigo, posicion)] }) },
              }),
        children: hijos,
      },
    ],
  });
}

export async function descargarWord(): Promise<void> {
  if (!codigoValido()) return;
  if (totalItems() === 0) return;
  const hojas = state.hojas.filter((h) => h.slots.some((c) => c !== null));
  if (hojas.length === 0) return;
  let blob: Blob;
  try {
    const doc = await construirDocumento(
      hojas,
      state.codigoActivo ? state.codigoValor : "",
      state.codigoPosicion,
    );
    blob = await Packer.toBlob(doc);
  } catch {
    avisar("Word: no se pudo generar el documento.");
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombreArchivo();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function initExport(): void {
  btnDescargar.addEventListener("click", () => {
    void descargarWord();
  });
  btnPdf.addEventListener("click", () => {
    void descargarPdf();
  });
  btnImprimir.addEventListener("click", () => {
    void imprimir();
  });
}

/* ---- PDF / Imprimir: una zona oculta con la misma fuente que Word ---- */

/** Banda del código (null si no hay código que mostrar). */
function codigoPrint(codigo: string, posicion: PosicionCodigo): HTMLElement | null {
  if (codigo === "") return null;
  const el = document.createElement("div");
  el.className = "codigo-print";
  el.textContent = codigo;
  el.style.textAlign = posicion.endsWith("der") ? "right" : "left";
  return el;
}

/** Una hoja lógica como <section> carta: misma Plantilla que geometria(), en CSS. */
export function hojaPrint(hoja: Hoja, codigo: string, posicion: PosicionCodigo): HTMLElement {
  const p = layoutDe(hoja.layout);
  const supra = posicion.startsWith("sup");
  const seccion = document.createElement("section");
  seccion.className = "hoja-print";
  seccion.style.paddingTop = supra ? "0.6in" : "0.3in";
  seccion.style.paddingBottom = supra ? "0.3in" : "0.6in";
  const banda = codigoPrint(codigo, posicion);
  if (supra && banda) seccion.append(banda);
  const rejilla = document.createElement("div");
  rejilla.className = "rejilla-print";
  rejilla.style.gridTemplateColumns = `repeat(${p.cols}, 1fr)`;
  rejilla.style.gridTemplateRows = `repeat(${p.filas}, 1fr)`;
  p.pos.forEach(([fila, col, span], i) => {
    const item = hoja.slots[i];
    if (!item) return;
    const celda = document.createElement("div");
    celda.className = "celda-print";
    celda.style.gridRow = `${fila}`;
    celda.style.gridColumn = `${col} / span ${span}`;
    const img = document.createElement("img");
    // ponytail: imgUrl directo (ya es full-res y vive en la sesión); sin object URLs que revocar.
    img.src = item.imgUrl;
    img.alt = item.nombre;
    celda.append(img);
    rejilla.append(celda);
  });
  seccion.append(rejilla);
  if (!supra && banda) seccion.append(banda);
  return seccion;
}

/** Hojas con al menos un comprobante (mismo filtro que descargarWord). */
function hojasNoVacias(): Hoja[] {
  return state.hojas.filter((h) => h.slots.some((c) => c !== null));
}

/** Arma #zonaPrint si el gate pasa; false = no imprimir. */
function montarZona(): boolean {
  if (!codigoValido() || totalItems() === 0) return false;
  const hojas = hojasNoVacias();
  if (hojas.length === 0) return false;
  const codigo = state.codigoActivo ? state.codigoValor : "";
  zonaPrint.replaceChildren(...hojas.map((h) => hojaPrint(h, codigo, state.codigoPosicion)));
  zonaPrint.removeAttribute("hidden");
  return true;
}

/** Vacía #zonaPrint y la vuelve a ocultar (tras el diálogo). */
function limpiarZona(): void {
  zonaPrint.replaceChildren();
  zonaPrint.setAttribute("hidden", "");
}

/** Espera a que las imgs de la zona decodifiquen (las de display:none cargan tarde). */
async function esperarImagenes(): Promise<void> {
  const imgs = [...zonaPrint.querySelectorAll("img")];
  // ponytail: decode fuerza carga+decode aun oculta; rota → hueco, nunca cuelga el diálogo.
  await Promise.all(imgs.map((img) => img.decode?.().catch(() => {})));
}

/** Imprime la zona y la limpia al cerrarse el diálogo (OK o cancelar). */
async function imprimirZona(): Promise<void> {
  await esperarImagenes();
  const limpiar = (): void => {
    limpiarZona();
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  window.print();
}

export async function descargarPdf(): Promise<void> {
  if (!montarZona()) return;
  // ponytail: Chrome propone document.title como nombre del PDF; sin API real de filename.
  const titulo = document.title;
  document.title = nombreArchivo("pdf").replace(/\.pdf$/, "");
  await esperarImagenes();
  const limpiar = (): void => {
    document.title = titulo;
    limpiarZona();
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  window.print();
}

export async function imprimir(): Promise<void> {
  if (!montarZona()) return;
  await imprimirZona();
}

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}
