/* Tests P0: gate de admisión PDF (puro; el conteo real con pdf.js se valida manual). */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  PDF_MAX_BYTES,
  PDF_MAX_PAGINAS,
  admitirPdf,
  admiteTamanoPdf,
  esPdf,
  generarMiniaturaPdf,
} from "./pdf";

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

describe("generarMiniaturaPdf", () => {
  it("pasado de peso: null sin abrir", async () => {
    expect(
      await generarMiniaturaPdf(pdfDe("g.pdf", "application/pdf", PDF_MAX_BYTES + 1)),
    ).toBeNull();
  });

  it("bytes basura: null sin lanzar (jsdom no rasteriza)", async () => {
    await expect(generarMiniaturaPdf(pdfDe("b.pdf", "application/pdf", 100))).resolves.toBeNull();
  });
});
