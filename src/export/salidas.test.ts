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
  '<div id="montoTotal"></div><p id="aviso"></p><button id="btnDescargar2"></button><button id="btnPdf"></button><button id="btnImprimir"></button><div id="zonaPrint" hidden></div>';
const { state, crearHoja } = await import("../state");
const {
  GUTTER,
  codigoValido,
  construirDocumento,
  descargarPdf,
  descargarWord,
  encajar,
  geometria,
  hojaPrint,
  imprimir,
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
  it("código inválido: no dispara descarga y avisa", async () => {
    state.codigoActivo = true;
    state.codigoValor = "corto";
    sembrar();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
    expect(document.getElementById("aviso")?.textContent).toBe(
      "Código inválido: revisá los dígitos.",
    );
  });

  it("sin comprobantes: no dispara descarga y avisa", async () => {
    state.codigoActivo = false;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await descargarWord();
    expect(click).not.toHaveBeenCalled();
    expect(document.getElementById("aviso")?.textContent).toBe("Sin comprobantes para exportar.");
  });

  it("válido: clic con nombre y blob, y revoca a los 30s", async () => {
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
    vi.advanceTimersByTime(2000);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(28000);
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

  it("idempotente: recablear no duplica el print", async () => {
    state.hojas.length = 0;
    state.codigoActivo = false;
    sembrar();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    try {
      initExport();
      initExport();
      document.getElementById("btnImprimir")?.click();
      await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
      window.dispatchEvent(new Event("afterprint"));
    }
  });

  it.each(["btnPdf", "btnImprimir"])("%s imprime la zona (no avisa)", async (id) => {
    state.hojas.length = 0;
    state.codigoActivo = false;
    sembrar();
    const aviso = document.getElementById("aviso");
    if (aviso) aviso.textContent = "";
    const print = vi.fn();
    vi.stubGlobal("print", print);
    try {
      initExport();
      document.getElementById(id)?.click();
      // Handlers async (esperan el decode): el print llega después.
      await vi.waitFor(() => expect(print).toHaveBeenCalled());
      expect(document.getElementById("aviso")?.textContent).toBe("");
    } finally {
      vi.unstubAllGlobals();
      window.dispatchEvent(new Event("afterprint"));
    }
  });
});

describe("hojaPrint", () => {
  function hojaLlena(n: number, layout: LayoutId = "u4x2") {
    const h = crearHoja(layout);
    for (let i = 0; i < n; i++) h.slots[i] = comprobante();
    return h;
  }

  it("u4x2 ×4: rejilla 2×2, 4 celdas con img full-res y footer inf-der", () => {
    const sec = hojaPrint(hojaLlena(4), "123456", "inf-der");
    expect(sec.className).toBe("hoja-print");
    const rejilla = sec.querySelector(":scope > .rejilla-print") as HTMLElement;
    expect(rejilla.style.gridTemplateColumns).toBe("repeat(2, 1fr)");
    expect(rejilla.style.gridTemplateRows).toBe("repeat(2, 1fr)");
    const imgs = rejilla.querySelectorAll(".celda-print > img");
    expect(imgs).toHaveLength(4);
    for (const img of imgs) {
      expect((img as HTMLImageElement).src).toBe("blob:mock-1");
      expect((img as HTMLImageElement).alt).toBe("factura.png");
    }
    const banda = sec.querySelector(":scope > .codigo-print") as HTMLElement;
    expect(banda.textContent).toBe("123456");
    expect(banda.style.textAlign).toBe("right");
    expect(sec.lastElementChild).toBe(banda);
  });

  it("nulos se saltan, spans se respetan (u3m)", () => {
    const sec = hojaPrint(hojaLlena(3, "u3m"), "1", "inf-izq");
    const celdas = sec.querySelectorAll(".celda-print");
    expect(celdas).toHaveLength(3);
    expect((celdas[2] as HTMLElement).style.gridColumn).toBe("1 / span 2");
  });

  it("sup-izq: banda primera a la izquierda y padding 0.6 arriba", () => {
    const sec = hojaPrint(hojaLlena(1), "99", "sup-izq");
    expect(sec.style.paddingTop).toBe("0.6in");
    expect(sec.style.paddingBottom).toBe("0.3in");
    const banda = sec.querySelector(":scope > .codigo-print") as HTMLElement;
    expect(sec.firstElementChild).toBe(banda);
    expect(banda.style.textAlign).toBe("left");
  });

  it("sin código: sin banda", () => {
    const sec = hojaPrint(hojaLlena(1), "", "inf-der");
    expect(sec.querySelector(".codigo-print")).toBeNull();
  });
});

describe("descargarPdf / imprimir", () => {
  function zona(): HTMLElement {
    const z = document.getElementById("zonaPrint");
    if (!z) throw new Error("zona ausente");
    return z;
  }

  beforeEach(() => {
    state.hojas.length = 0;
    state.codigoActivo = false;
    document.title = "";
    zona().replaceChildren();
    vi.stubGlobal("print", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function impresiones(): number {
    return (globalThis.print as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  it("gate código inválido: no imprime ni monta, y avisa", async () => {
    state.codigoActivo = true;
    state.codigoValor = "corto";
    sembrar();
    await descargarPdf();
    expect(document.getElementById("aviso")?.textContent).toBe(
      "Código inválido: revisá los dígitos.",
    );
    await imprimir();
    expect(impresiones()).toBe(0);
    expect(zona().childElementCount).toBe(0);
    expect(document.title).toBe("");
  });

  it("sin comprobantes: no imprime y avisa", async () => {
    await descargarPdf();
    expect(document.getElementById("aviso")?.textContent).toBe("Sin comprobantes para exportar.");
    await imprimir();
    expect(impresiones()).toBe(0);
  });

  it("descargarPdf válido: monta N hojas, título temporal, imprime y limpia", async () => {
    sembrar();
    sembrar();
    await descargarPdf();
    const hojas = zona().querySelectorAll(":scope > .hoja-print");
    expect(hojas).toHaveLength(2);
    expect(zona().querySelectorAll(".celda-print > img")).toHaveLength(2);
    expect(document.title).toBe("sincodigo-comprobante");
    expect(impresiones()).toBe(1);
    window.dispatchEvent(new Event("afterprint"));
    expect(zona().childElementCount).toBe(0);
    expect(document.title).toBe("");
  });

  it("imprimir válido: no toca el título y limpia al cerrar", async () => {
    document.title = "App";
    sembrar();
    await imprimir();
    expect(impresiones()).toBe(1);
    expect(document.title).toBe("App");
    expect(zona().querySelectorAll(":scope > .hoja-print")).toHaveLength(1);
    window.dispatchEvent(new Event("afterprint"));
    expect(zona().childElementCount).toBe(0);
  });

  it("espera al decode de las imgs antes de print", async () => {
    let resolver: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      resolver = res;
    });
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = (() => puerta) as typeof original;
    try {
      sembrar();
      const vuelto = descargarPdf();
      // Zona montada pero diálogo aún no abierto: las imgs no decodificaron.
      expect(zona().querySelectorAll(":scope > .hoja-print")).toHaveLength(1);
      expect(impresiones()).toBe(0);
      resolver();
      await vuelto;
      expect(impresiones()).toBe(1);
    } finally {
      HTMLImageElement.prototype.decode = original;
      window.dispatchEvent(new Event("afterprint"));
    }
  });

  it("doble llamado en vuelo: un solo print y título intacto", async () => {
    let resolver: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      resolver = res;
    });
    const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = (() => puerta) as typeof original;
    try {
      document.title = "App";
      sembrar();
      const primero = descargarPdf();
      const segundo = descargarPdf();
      resolver();
      await primero;
      await segundo;
      expect(impresiones()).toBe(1);
    } finally {
      HTMLImageElement.prototype.decode = original;
      window.dispatchEvent(new Event("afterprint"));
    }
    expect(document.title).toBe("App");
  });
});
