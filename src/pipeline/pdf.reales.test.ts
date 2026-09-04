/* Tests locales con PDFs reales (archivos-test/pdf-test/, gitignored).
   Solo-local: en CI los fixtures no existen → skipIf. Blancas (t5/t6/t7)
   solo a nivel gate aquí; el conteo real de blancas es manual en Chrome
   (jsdom no tiene canvas 2d). Nunca asserts de bytes exactos. */
import { describe, expect, it, vi } from "vite-plus/test";
import { PDF_MAX_BYTES, admitirPdf, admiteTamanoPdf, contarPaginasPdf, expandirPdf } from "./pdf";

/** Mínimo de node:fs usado (sin @types/node a propósito: cero deps nuevas). */
const fs: { existsSync: (ruta: string) => boolean; readFileSync: (ruta: string) => Uint8Array } =
  // @ts-expect-error sin tipos de node en el proyecto; vitest sí trae el runtime.
  await import("node:fs");

// import.meta.url bajo vite-node no es file://; dirname sí trae ruta real.
// @ts-expect-error sin @types/node en el proyecto; en runtime existe.
const DIRNAME: string = import.meta.dirname;
const DIR = `${DIRNAME}/../../archivos-test/pdf-test`;
const HAY: boolean = fs.existsSync(DIR);

// pdf.js 6 usa Uint8Array.toHex (V8 reciente); el node que corre vitest
// puede no traerlo → polyfill local a este archivo (solo tests).
// No es código muerto: lo usa pdfjs-dist internamente al abrir documentos.
const proto = Uint8Array.prototype as unknown as Record<string, unknown>;
if (typeof proto["toHex"] !== "function") {
  proto["toHex"] = function (this: Uint8Array): string {
    return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
  };
}

// vite-node no resuelve el worker `?url` (da file:// roto o http:): se fija
// el file:// real desde dirname (con pnpm hay symlink y ESM lo sigue).
// En producción el `?url` del bundle manda (el ||= de pdf.ts lo respeta).
const workerRuta = `${DIRNAME}/../../node_modules/pdfjs-dist/build/pdf.worker.mjs`.replace(
  /\\/g,
  "/",
);
const workerUrl: string = new URL(`file:///${workerRuta}`).href;
const { GlobalWorkerOptions } = await import("pdfjs-dist");
GlobalWorkerOptions.workerSrc = workerUrl;

function cargar(nombre: string): File {
  const buf = new Uint8Array(fs.readFileSync(`${DIR}/${nombre}`));
  const f = new File([buf], nombre, { type: "application/pdf" });
  expect(f.size).toBeGreaterThan(0);
  return f;
}

/** Spy que falla si el gate abre el documento (prueba de peso-primero). */
function noAbrir(): (f: File) => Promise<number> {
  return vi.fn(async (): Promise<number> => {
    throw new Error("no debe abrir");
  });
}

describe.skipIf(!HAY)("pdf reales (local, archivos-test/ ignorado)", () => {
  it("t1: 1 página liviana → admitido", async () => {
    const f = cargar("test1_1pagina_under5mb.pdf");
    expect(admiteTamanoPdf(f)).toBe(true);
    expect(await contarPaginasPdf(f)).toBe(1);
    expect(await admitirPdf(f, contarPaginasPdf)).toEqual({ admite: true });
  });

  it("t2: > 5 MB → tamano sin abrir", async () => {
    const f = cargar("test2_1pagina_over5mb.pdf");
    expect(f.size).toBeGreaterThan(PDF_MAX_BYTES);
    const contar = noAbrir();
    expect(await admitirPdf(f, contar)).toEqual({ admite: false, motivo: "tamano" });
    expect(contar).not.toHaveBeenCalled();
  });

  it("t3: 10 páginas livianas → admitido (borde inclusivo)", async () => {
    const f = cargar("test3_10paginas_under5mb.pdf");
    expect(await contarPaginasPdf(f)).toBe(10);
    expect(await admitirPdf(f, contarPaginasPdf)).toEqual({ admite: true });
  });

  it("t4: 12 páginas → paginas", async () => {
    const f = cargar("test4_12paginas_under5mb.pdf");
    expect(await contarPaginasPdf(f)).toBe(12);
    expect(await admitirPdf(f, contarPaginasPdf)).toEqual({ admite: false, motivo: "paginas" });
  });

  it("t9: 11 páginas → paginas (off-by-one)", async () => {
    const f = cargar("test9_limite_borde_11paginas.pdf");
    expect(await contarPaginasPdf(f)).toBe(11);
    expect(await admitirPdf(f, contarPaginasPdf)).toEqual({ admite: false, motivo: "paginas" });
  });

  it("t8: > 5 MB y 12 páginas → tamano primero, sin abrir", async () => {
    const f = cargar("test8_over5mb_12paginas.pdf");
    expect(f.size).toBeGreaterThan(PDF_MAX_BYTES);
    const contar = noAbrir();
    expect(await admitirPdf(f, contar)).toEqual({ admite: false, motivo: "tamano" });
    expect(contar).not.toHaveBeenCalled();
  });

  it("t0: cifrado → cifrado sin lanzar", async () => {
    const f = cargar("test0_documento_cifrado_test.pdf");
    await expect(admitirPdf(f, contarPaginasPdf)).resolves.toEqual({
      admite: false,
      motivo: "cifrado",
    });
  });

  it("t10: corrupto → ilegible y expandir da [] sin lanzar", async () => {
    const f = cargar("test10_corrupto_header_invalido.pdf");
    await expect(admitirPdf(f, contarPaginasPdf)).resolves.toEqual({
      admite: false,
      motivo: "ilegible",
    });
    await expect(expandirPdf(f)).resolves.toEqual([]);
  });

  it("t5/t6/t7: gate cuenta y admite (blancas → manual en Chrome)", async () => {
    const t5 = cargar("test5_8paginas_4blancas_under5mb.pdf");
    expect(await contarPaginasPdf(t5)).toBe(8);
    expect(await admitirPdf(t5, contarPaginasPdf)).toEqual({ admite: true });
    const t6 = cargar("test6_3paginas_todas_blancas.pdf");
    expect(await contarPaginasPdf(t6)).toBe(3);
    expect(await admitirPdf(t6, contarPaginasPdf)).toEqual({ admite: true });
    const t7 = cargar("test7_paginas_visualmente_blancas.pdf");
    expect(await contarPaginasPdf(t7)).toBe(2);
    expect(await admitirPdf(t7, contarPaginasPdf)).toEqual({ admite: true });
  });
});
