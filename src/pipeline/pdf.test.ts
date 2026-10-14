/* Tests P0: gate de admisión PDF (puro; el conteo real con pdf.js se valida manual). */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  PDF_MAX_BYTES,
  PDF_MAX_PAGINAS,
  admitirPdf,
  admiteTamanoPdf,
  esPaginaBlanca,
  esPaginaNegra,
  esPdf,
  expandirPdf,
  vistaSegura,
} from "./pdf";
import type { DocumentoPdf } from "./pdf";

// pdf.js real no corre en jsdom (necesita worker): abrirPdfReal se prueba con
// documento falso, entrando por el default de expandirPdf (la función real).
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

const pdfjsFalso = await import("pdfjs-dist");
const getDocumentFalso = vi.mocked(pdfjsFalso.getDocument);

function pdfDe(nombre: string, type: string, size: number): File {
  const f = new File(["x"], nombre, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("esPdf", () => {
  it("acepta por MIME o por extensión (insensible a mayúsculas)", () => {
    expect(esPdf(pdfDe("a.pdf", "application/pdf", 10))).toBe(true);
    expect(esPdf(pdfDe("b.pdf", "application/octet-stream", 10))).toBe(true);
    expect(esPdf(pdfDe("c.PDF", "application/pdf", 10))).toBe(true);
  });

  it("rechaza lo que no es PDF", () => {
    expect(esPdf(pdfDe("a.png", "image/png", 10))).toBe(false);
    expect(esPdf(pdfDe("b.txt", "text/plain", 10))).toBe(false);
  });
});

describe("admiteTamanoPdf", () => {
  it("acepta (0, 5 MiB] y rechaza 0 y el exceso", () => {
    expect(admiteTamanoPdf(pdfDe("a.pdf", "application/pdf", 1))).toBe(true);
    expect(admiteTamanoPdf(pdfDe("b.pdf", "application/pdf", PDF_MAX_BYTES))).toBe(true);
    expect(admiteTamanoPdf(pdfDe("c.pdf", "application/pdf", 0))).toBe(false);
    expect(admiteTamanoPdf(pdfDe("d.pdf", "application/pdf", PDF_MAX_BYTES + 1))).toBe(false);
  });
});

describe("admitirPdf", () => {
  it("admite ≤ 10 páginas y rechaza 11+", async () => {
    const contar = async (): Promise<number> => 5;
    expect(await admitirPdf(pdfDe("a.pdf", "application/pdf", 100), contar)).toEqual({
      admite: true,
    });
    expect(
      await admitirPdf(pdfDe("b.pdf", "application/pdf", 100), () => Promise.resolve(10)),
    ).toEqual({
      admite: true,
    });
    expect(
      await admitirPdf(pdfDe("c.pdf", "application/pdf", 100), () => Promise.resolve(11)),
    ).toEqual({
      admite: false,
      motivo: "paginas",
    });
    expect(PDF_MAX_PAGINAS).toBe(10);
  });

  it("rechaza por tamaño sin abrir el documento", async () => {
    const contar = vi.fn(async (): Promise<number> => 5);
    expect(await admitirPdf(pdfDe("g.pdf", "application/pdf", PDF_MAX_BYTES + 1), contar)).toEqual({
      admite: false,
      motivo: "tamano",
    });
    expect(contar).not.toHaveBeenCalled();
  });

  it("cero bytes es ilegible sin abrir", async () => {
    const contar = vi.fn(async (): Promise<number> => 5);
    expect(await admitirPdf(pdfDe("v.pdf", "application/pdf", 0), contar)).toEqual({
      admite: false,
      motivo: "ilegible",
    });
    expect(contar).not.toHaveBeenCalled();
  });

  it("clasifica contraseña vs ilegible", async () => {
    const clave = (): Promise<number> => {
      const e = new Error("contraseña");
      e.name = "PasswordException";
      throw e;
    };
    expect(await admitirPdf(pdfDe("c.pdf", "application/pdf", 100), clave)).toEqual({
      admite: false,
      motivo: "cifrado",
    });
    const roto = (): Promise<number> => {
      throw new Error("bytes basura");
    };
    expect(await admitirPdf(pdfDe("r.pdf", "application/pdf", 100), roto)).toEqual({
      admite: false,
      motivo: "ilegible",
    });
  });
});

describe("esPaginaBlanca", () => {
  // Lienzo falso con píxeles dados (jsdom no da contexto 2d real).
  function lienzoFalso(pixeles: number[]): HTMLCanvasElement {
    const datos = new Uint8ClampedArray(pixeles);
    return {
      width: 2,
      height: 2,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
      toBlob: (cb: (b: Blob | null) => void): void => {
        cb(new Blob(["x"], { type: "image/jpeg" }));
      },
    } as unknown as HTMLCanvasElement;
  }
  const px = (n: number, r: number, g: number, b: number, a = 255): number[] =>
    Array.from({ length: n }, () => [r, g, b, a]).flat();

  it("todo blanco → vacía", () => {
    expect(esPaginaBlanca(lienzoFalso(px(4, 255, 255, 255)))).toBe(true);
  });

  it("transparente cuenta como blanco (PDF sin fondo)", () => {
    expect(esPaginaBlanca(lienzoFalso(px(4, 0, 0, 0, 0)))).toBe(true);
  });

  it("un píxel de tinta → no vacía", () => {
    expect(esPaginaBlanca(lienzoFalso([...px(1, 0, 0, 0), ...px(3, 255, 255, 255)]))).toBe(false);
  });

  it("canal justo en 245 no es blanco (umbral exclusivo)", () => {
    expect(esPaginaBlanca(lienzoFalso(px(4, 245, 245, 245)))).toBe(false);
  });

  it("gris app #f7f8fa lleno → vacía", () => {
    expect(esPaginaBlanca(lienzoFalso(px(4, 247, 248, 250)))).toBe(true);
  });
});

describe("esPaginaNegra", () => {
  function lienzoFalso(pixeles: number[]): HTMLCanvasElement {
    const datos = new Uint8ClampedArray(pixeles);
    return {
      width: 2,
      height: 2,
      getContext: (): unknown => ({
        getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
      }),
      toBlob: (cb: (b: Blob | null) => void): void => {
        cb(new Blob(["x"], { type: "image/jpeg" }));
      },
    } as unknown as HTMLCanvasElement;
  }
  const px = (n: number, r: number, g: number, b: number, a = 255): number[] =>
    Array.from({ length: n }, () => [r, g, b, a]).flat();

  it("todo negro → vacía", () => {
    expect(esPaginaNegra(lienzoFalso(px(4, 0, 0, 0)))).toBe(true);
  });

  it("un píxel claro → no vacía", () => {
    expect(esPaginaNegra(lienzoFalso([...px(1, 255, 255, 255), ...px(3, 0, 0, 0)]))).toBe(false);
  });
});

describe("expandirPdf", () => {
  function abrirFalso(
    opc: {
      total?: number;
      blancas?: number[];
      negras?: number[];
      nulas?: number[];
      rotas?: number[];
      cerrarRota?: boolean;
    } = {},
  ): {
    abrir: (f: File) => Promise<DocumentoPdf>;
    fueCerrado: () => boolean;
  } {
    let cerrado = false;
    // Tinta gris media: ni blanca ni negra para los gates (el 2x2 solo muestrea el píxel 0).
    const tin = (blanca: boolean, negra: boolean): number[] =>
      negra ? [0, 0, 0, 255] : blanca ? [255, 255, 255, 255] : [100, 100, 100, 255];
    const abrir = async (): Promise<DocumentoPdf> => ({
      total: opc.total ?? 3,
      renderizar: async (i: number): Promise<HTMLCanvasElement | null> => {
        if (opc.rotas?.includes(i)) throw new Error("rota");
        const nula = opc.nulas?.includes(i) ?? false;
        const negra = opc.negras?.includes(i) ?? false;
        const t = tin(opc.blancas?.includes(i) ?? false, negra);
        const relleno = negra ? 0 : 255;
        const datos = new Uint8ClampedArray([
          ...t,
          relleno,
          relleno,
          relleno,
          255,
          relleno,
          relleno,
          relleno,
          255,
          relleno,
          relleno,
          relleno,
        ]);
        return {
          width: 2,
          height: 2,
          getContext: (): unknown => ({
            getImageData: (): { data: Uint8ClampedArray } => ({ data: datos }),
          }),
          toBlob: (cb: (b: Blob | null) => void): void => {
            cb(nula ? null : new Blob(["x"], { type: "image/jpeg" }));
          },
        } as unknown as HTMLCanvasElement;
      },
      cerrar: async (): Promise<void> => {
        if (opc.cerrarRota) throw new Error("destroy caído");
        cerrado = true;
      },
    });
    return { abrir, fueCerrado: (): boolean => cerrado };
  }

  it("3 páginas con 1 blanca → 2 útiles en orden, y cierra", async () => {
    const { abrir, fueCerrado } = abrirFalso({ blancas: [2] });
    const pags = await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir);
    expect(pags.map((p) => [p.indice, p.total])).toEqual([
      [1, 3],
      [3, 3],
    ]);
    expect(pags.every((p) => p.blob instanceof Blob)).toBe(true);
    expect(fueCerrado()).toBe(true);
  });

  it("página rota no tumba a las hermanas", async () => {
    const { abrir } = abrirFalso({ rotas: [2] });
    const pags = await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir);
    expect(pags.map((p) => p.indice)).toEqual([1, 3]);
  });

  it("peso excedido → [] sin abrir", async () => {
    const { abrir } = abrirFalso();
    const espia = vi.fn(abrir);
    expect(await expandirPdf(pdfDe("g.pdf", "application/pdf", PDF_MAX_BYTES + 1), espia)).toEqual(
      [],
    );
    expect(espia).not.toHaveBeenCalled();
  });

  it("apertura rota → [] sin lanzar", async () => {
    const abrir = async (): Promise<DocumentoPdf> => {
      throw new Error("ilegible");
    };
    await expect(expandirPdf(pdfDe("r.pdf", "application/pdf", 100), abrir)).resolves.toEqual([]);
  });

  it("más de 10 páginas → [] (gate de contador)", async () => {
    const { abrir, fueCerrado } = abrirFalso({ total: 12 });
    expect(await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir)).toEqual([]);
    expect(fueCerrado()).toBe(true);
  });

  it("0 páginas → [] (gate inferior)", async () => {
    const { abrir } = abrirFalso({ total: 0 });
    expect(await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir)).toEqual([]);
  });

  it("página negra y toBlob nulo se saltan (la útil sobrevive)", async () => {
    const { abrir } = abrirFalso({ total: 3, negras: [1], nulas: [3] });
    const pags = await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir);
    expect(pags.map((p) => p.indice)).toEqual([2]);
  });

  it("cerrar que lanza no afecta la expansión", async () => {
    const { abrir } = abrirFalso({ cerrarRota: true });
    const pags = await expandirPdf(pdfDe("f.pdf", "application/pdf", 100), abrir);
    expect(pags.map((p) => p.indice)).toEqual([1, 2, 3]);
  });
});

describe("abrirPdfReal (default de expandirPdf, pdfjs falso)", () => {
  let destruida = false;
  function tareaFalsa(vista: { width: number; height: number }): unknown {
    const pagina = {
      getViewport: ({ scale }: { scale: number }): { width: number; height: number } =>
        scale === 1 ? vista : { width: vista.width * scale, height: vista.height * scale },
    };
    return {
      promise: Promise.resolve({ numPages: 2, getPage: async () => pagina }),
      destroy: async (): Promise<void> => {
        destruida = true;
      },
    };
  }
  function pdfReal(): File {
    return new File(["x".repeat(100)], "a.pdf", { type: "application/pdf" });
  }

  it("página normal: abre, salta el render sin ctx 2d y cierra", async () => {
    destruida = false;
    getDocumentFalso.mockReturnValue(tareaFalsa({ width: 200, height: 250 }) as never);
    const pags = await expandirPdf(pdfReal());
    expect(pags).toEqual([]);
    expect(destruida).toBe(true);
  });

  it("MediaBox extremo: vista insegura → null y cierra", async () => {
    destruida = false;
    pdfjsFalso.GlobalWorkerOptions.workerSrc = "fijado"; // cubre ||= ya configurado
    getDocumentFalso.mockReturnValue(tareaFalsa({ width: 1, height: 4000 }) as never);
    const pags = await expandirPdf(pdfReal());
    expect(pags).toEqual([]);
    expect(destruida).toBe(true);
  });

  it("documento ilegible → [] sin lanzar", async () => {
    getDocumentFalso.mockImplementation(() => {
      throw new Error("ilegible");
    });
    await expect(expandirPdf(pdfReal())).resolves.toEqual([]);
  });
});

describe("vistaSegura", () => {
  it("normal sí; MediaBox extremo (1pt ancho, NaN, área gigante) no", () => {
    expect(vistaSegura(720, 1000)).toBe(true);
    expect(vistaSegura(1, 1000)).toBe(true); // base angosta pero real; el escalado la filtra
    expect(vistaSegura(720, 720000)).toBe(false); // 518M px colgaría la pestaña
    expect(vistaSegura(NaN, 100)).toBe(false);
    expect(vistaSegura(0, 100)).toBe(false);
  });
});
