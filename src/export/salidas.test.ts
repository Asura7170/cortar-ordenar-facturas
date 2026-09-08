/* Tests salida Word (salidas.ts necesita #montoTotal, #btnDescargar2, #btnPdf y
   #btnImprimir al importar; docx va mockeado: se aserta la estructura armada). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ORDEN_PLANTILLAS } from "../ui/layout";
import type { LayoutId, PosicionCodigo } from "../types";

interface Registro {
  readonly tipo: string;
  readonly opc: unknown;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

vi.mock("docx", () => {
  const apuntados: Registro[] = [];
  class Apunte {
    readonly tipo: string;
    readonly opc: unknown;
    constructor(tipo: string, opc: unknown) {
      this.tipo = tipo;
      this.opc = opc;
      apuntados.push({ tipo, opc });
    }
  }
  const fabrica = (tipo: string): new (opc?: unknown) => Apunte =>
    class extends Apunte {
      constructor(opc?: unknown) {
        super(tipo, opc);
      }
    };
  return {
    AlignmentType: { LEFT: "left", RIGHT: "right" },
    Document: fabrica("Document"),
    Paragraph: fabrica("Paragraph"),
    TextRun: fabrica("TextRun"),
    ImageRun: fabrica("ImageRun"),
    Header: fabrica("Header"),
    Footer: fabrica("Footer"),
    PageBreak: fabrica("PageBreak"),
    HorizontalPositionRelativeFrom: { PAGE: "page" },
    VerticalPositionRelativeFrom: { PAGE: "page" },
    TextWrappingType: { SQUARE: 1 },
    TextWrappingSide: { BOTH_SIDES: "bothSides" },
    PageOrientation: { PORTRAIT: "portrait" },
    convertInchesToTwip: (n: number): number => Math.round(n * 1440),
    Packer: {
      toBlob: async (): Promise<Blob> =>
        new Blob(["docx"], {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
    },
    __apuntados: apuntados,
  };
});

// jsdom no implementa createImageBitmap: falso 800×600 con close().
const bitmapFalso = (async (): Promise<ImageBitmap> =>
  ({
    width: 800,
    height: 600,
    close: () => {},
  }) as unknown as ImageBitmap) as typeof createImageBitmap;
globalThis.createImageBitmap = bitmapFalso;

document.body.innerHTML =
  '<div id="montoTotal"></div><p id="aviso"></p><button id="btnDescargar2"></button><button id="btnPdf"></button><button id="btnImprimir"></button>';
const { state, crearHoja } = await import("../state");
const {
  GUTTER,
  codigoValido,
  construirDocumento,
  descargarWord,
  encajar,
  geometria,
  initExport,
  nombreArchivo,
} = await import("./salidas");
const { comprobante } = await import("../test/factoria");
const { __apuntados: registrados } = (await import("docx")) as unknown as {
  __apuntados: Registro[];
};

const EMU = 914400;
const POSICIONES: readonly PosicionCodigo[] = ["sup-izq", "sup-der", "inf-izq", "inf-der"];

beforeEach(() => {
  registrados.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  globalThis.createImageBitmap = bitmapFalso;
});

function sembrar(monto: number | null = 123456): void {
  const h = crearHoja();
  h.slots[0] = comprobante({ montoCents: monto, file: new Blob(["jpg"], { type: "image/jpeg" }) });
  state.hojas.push(h);
}

function deTipo(tipo: string): Registro[] {
  return registrados.filter((r) => r.tipo === tipo);
}

function seSolapan(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function dentroDeCarta(rects: readonly Rect[]): void {
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.w).toBeLessThanOrEqual(Math.round(8.5 * EMU));
    expect(r.y + r.h).toBeLessThanOrEqual(Math.round(11 * EMU));
  }
}

function sinSolapes(rects: readonly Rect[]): void {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a || !b) throw new Error("rect ausente");
      expect(seSolapan(a, b)).toBe(false);
    }
}

/** Vecinas del mismo eje separadas por al menos la calle (el hueco visible). */
function conCalle(rects: readonly Rect[], calle: number): void {
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a || !b) throw new Error("rect ausente");
      const huecoX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
      const huecoY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      // En el eje que comparten hay calle; en el otro pueden solaparse (grilla).
      expect(huecoX >= calle || huecoY >= calle).toBe(true);
    }
}

function seccionDe(doc: Registro): Record<string, unknown> {
  const secs = (doc.opc as { sections: Record<string, unknown>[] }).sections;
  const sec = secs[0];
  if (!sec) throw new Error("sección ausente");
  return sec;
}

describe("codigoValido", () => {
  it("sin código activo siempre vale", () => {
    state.codigoActivo = false;
    state.codigoValor = "cualquier-cosa";
    expect(codigoValido()).toBe(true);
  });

  it.each([
    ["123456", 6, true],
    ["12345", 6, false],
    ["1234567", 6, false],
    ["12345a", 6, false],
    ["", 6, false],
  ])("valor %s con longitud %i → %s", (valor, longitud, esperado) => {
    state.codigoActivo = true;
    state.codigoLongitud = longitud;
    state.codigoValor = valor;
    expect(codigoValido()).toBe(esperado);
  });
});

describe("nombreArchivo", () => {
  it('con código usa el valor, sin código usa "sincodigo"', () => {
    state.codigoActivo = true;
    state.codigoValor = "123456";
    expect(nombreArchivo()).toBe("123456-comprobante.docx");
    state.codigoActivo = false;
    expect(nombreArchivo()).toBe("sincodigo-comprobante.docx");
  });

  it("acepta extensión (reúso PDF)", () => {
    state.codigoActivo = true;
    state.codigoValor = "123456";
    expect(nombreArchivo("pdf")).toBe("123456-comprobante.pdf");
  });
});

describe("geometria", () => {
  it("u4x2 inf-der: 4 rects con banda inferior libre", () => {
    const rects = geometria("u4x2", "inf-der");
    expect(rects).toHaveLength(4);
    dentroDeCarta(rects);
    sinSolapes(rects);
    for (const r of rects) {
      expect(r.y).toBeGreaterThanOrEqual(Math.round(0.3 * EMU));
      expect(r.y + r.h).toBeLessThanOrEqual(Math.round((11 - 0.6) * EMU));
    }
  });

  it("u1 sup-izq: 1 rect con banda superior libre", () => {
    const rects = geometria("u1", "sup-izq");
    expect(rects).toHaveLength(1);
    const r = rects[0];
    if (!r) throw new Error("rect ausente");
    expect(r.y).toBeGreaterThanOrEqual(Math.round(0.6 * EMU));
    expect(r.y + r.h).toBeLessThanOrEqual(Math.round((11 - 0.3) * EMU));
  });

  it.each(ORDEN_PLANTILLAS)(
    "plantilla %s: 1 rect por casilla, dentro, sin solapes y con calle ×4 esquinas",
    (id: LayoutId) => {
      const total = geometria(id, "inf-der").length;
      // Redondeo EMU por rect: la calle real puede ceder 2 EMU.
      const calle = Math.round(GUTTER * EMU) - 2;
      for (const pos of POSICIONES) {
        const rects = geometria(id, pos);
        expect(rects).toHaveLength(total);
        dentroDeCarta(rects);
        sinSolapes(rects);
        conCalle(rects, calle);
      }
    },
  );
});

describe("encajar", () => {
  const rect: Rect = { x: 0, y: 0, w: 800 * 9525, h: 600 * 9525 };

  it("apaisada llena el ancho", () => {
    expect(encajar(1600, 600, rect)).toEqual({ w: 800, h: 300 });
  });

  it("vertical llena el alto", () => {
    expect(encajar(600, 1200, rect)).toEqual({ w: 300, h: 600 });
  });

  it("sin dimensiones usa el rect entero", () => {
    expect(encajar(0, 0, rect)).toEqual({ w: 800, h: 600 });
  });
});

describe("construirDocumento (docx mockeado)", () => {
  function hojaCon(n: number): void {
    const h = crearHoja();
    for (let i = 0; i < n; i++)
      h.slots[i] = comprobante({ file: new Blob([`jpg${i}`], { type: "image/jpeg" }) });
    state.hojas.push(h);
  }

  it("1 hoja ×2 items: 2 ImageRun flotantes PAGE+SQUARE, footer, sin PageBreak", async () => {
    hojaCon(2);
    await construirDocumento(state.hojas, "123456", "inf-der");
    const imgs = deTipo("ImageRun");
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      const o = img.opc as {
        type: string;
        data: ArrayBuffer;
        transformation: { width: number; height: number };
        floating: {
          horizontalPosition: { relative: string; offset: number };
          verticalPosition: { relative: string; offset: number };
          allowOverlap: boolean;
          wrap: { type: number };
        };
      };
      expect(o.type).toBe("jpg");
      expect(o.data).toBeInstanceOf(ArrayBuffer);
      expect(o.transformation.width).toBeGreaterThan(0);
      expect(o.floating.horizontalPosition.relative).toBe("page");
      expect(o.floating.verticalPosition.relative).toBe("page");
      expect(o.floating.allowOverlap).toBe(true);
      expect(o.floating.wrap.type).toBe(1);
    }
    const docs = deTipo("Document");
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    if (!doc) throw new Error("documento ausente");
    const sec = seccionDe(doc);
    expect(sec["footers"]).toBeDefined();
    expect(sec["headers"]).toBeUndefined();
    expect(deTipo("PageBreak")).toHaveLength(0);
  });

  it("sup-izq: header (no footer) alineado a la izquierda", async () => {
    hojaCon(1);
    await construirDocumento(state.hojas, "123456", "sup-izq");
    const docs = deTipo("Document");
    const doc = docs[0];
    if (!doc) throw new Error("documento ausente");
    const sec = seccionDe(doc);
    expect(sec["headers"]).toBeDefined();
    expect(sec["footers"]).toBeUndefined();
    const zurdo = deTipo("Paragraph").some(
      (p) => (p.opc as { alignment?: string }).alignment === "left",
    );
    expect(zurdo).toBe(true);
  });

  it("2 hojas: un PageBreak entre párrafos", async () => {
    hojaCon(1);
    hojaCon(1);
    await construirDocumento(state.hojas, "123456", "inf-der");
    expect(deTipo("ImageRun")).toHaveLength(2);
    expect(deTipo("PageBreak")).toHaveLength(1);
  });

  it("sin código: ni header ni footer", async () => {
    hojaCon(1);
    await construirDocumento(state.hojas, "", "inf-der");
    const docs = deTipo("Document");
    const doc = docs[0];
    if (!doc) throw new Error("documento ausente");
    const sec = seccionDe(doc);
    expect(sec["headers"]).toBeUndefined();
    expect(sec["footers"]).toBeUndefined();
  });
});

describe("descargarWord", () => {
  it("código inválido: no dispara descarga", async () => {
    state.codigoActivo = true;
    state.codigoValor = "corto";
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
  });

  it("sin comprobantes: no dispara descarga", async () => {
    state.codigoActivo = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
  });

  it("válido: clic con nombre y blob, y revoca a los 2s", async () => {
    vi.useFakeTimers();
    state.codigoActivo = false;
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await descargarWord();
    expect(click).toHaveBeenCalledTimes(1);
    const a = click.mock.instances[0] as HTMLAnchorElement;
    expect(a.download).toBe("sincodigo-comprobante.docx");
    expect(a.href).toContain("blob:mock-");
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("fallo de generación: avisa y no descarga", async () => {
    state.codigoActivo = false;
    sembrar();
    globalThis.createImageBitmap = (() =>
      Promise.reject(new Error("boom"))) as unknown as typeof createImageBitmap;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
    expect(document.getElementById("aviso")?.textContent).toBe(
      "Word: no se pudo generar el documento.",
    );
  });
});

describe("initExport", () => {
  it("cablea el botón a descargarWord", async () => {
    state.codigoActivo = false;
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    initExport();
    document.getElementById("btnDescargar2")?.click();
    // descargarWord es async (mide + empaca): el clic del anchor llega después.
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  });

  // ponytail: placeholders habilitados que avisan (sin funcionalidad real).
  it.each([
    ["btnPdf", "PDF: próximamente."],
    ["btnImprimir", "Imprimir: próximamente."],
  ])("%s avisa sin descargar", (id, mensaje) => {
    initExport();
    document.getElementById(id)?.click();
    expect(document.getElementById("aviso")?.textContent).toBe(mensaje);
  });
});
