/* Tests P1: sidebar — entrada de archivos, código de pedido y limpiar (DOM aislado). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  montarFixture,
  el,
  eventoDrop,
  eventoDragenter,
  eventoDragleave,
  eventoPaste,
} from "../test/fixture";
import type { PaginaPdf } from "../pipeline/pdf";

// El conteo real abre el PDF con pdf.js: stub fijo (cada test lo ajusta).
let paginasSimuladas = 5;
// El raster real necesita Chrome: expansión stub (cada test la ajusta).
function paginaSimulada(indice: number, total: number): PaginaPdf {
  return { indice, total, blob: new Blob(["x"], { type: "image/jpeg" }) };
}
let expansionSimulada: PaginaPdf[] = [paginaSimulada(1, 1)];
// La normalización real necesita Chrome: stub (cada test lo ajusta).
const fallosImagen = new Map<string, string>();
vi.mock("../pipeline/imagen", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/imagen")>();
  return {
    ...real,
    normalizarImagen: async (f: File): Promise<Blob> => {
      const motivo = fallosImagen.get(f.name);
      if (motivo) throw new Error(motivo);
      return new Blob(["x"], { type: "image/jpeg" });
    },
  };
});
vi.mock("../pipeline/pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/pdf")>();
  return {
    ...real,
    contarPaginasPdf: async (): Promise<number> => paginasSimuladas,
    expandirPdf: async (): Promise<PaginaPdf[]> => expansionSimulada,
  };
});

montarFixture();
const { state, crearHoja } = await import("../state");
const { agregarArchivos, elegirArchivos, initSidebar, renderCodigo } = await import("./sidebar");
const { archivo, comprobante } = await import("../test/factoria");

const canvas = el("canvas");
const aviso = el("aviso");
const fileInput = el<HTMLInputElement>("fileInput");
const chkCodigo = el<HTMLInputElement>("chkCodigo");
const numCodigo = el<HTMLInputElement>("numCodigo");
const inputCodigo = el<HTMLInputElement>("inputCodigo");
const modalLimpiar = el<HTMLDialogElement>("modalLimpiar");

initSidebar();

beforeEach(() => {
  // La cola MOCK usa sleep(900ms): timers falsos para que nunca avance en tests.
  vi.useFakeTimers();
  paginasSimuladas = 5;
  fallosImagen.clear();
  expansionSimulada = [paginaSimulada(1, 1)];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("agregarArchivos", () => {
  it("null o vacío: no hace nada", async () => {
    await agregarArchivos(null);
    await agregarArchivos([]);
    expect(state.hojas).toHaveLength(0);
  });

  it("filtra por tipo: imagen y pdf sí, txt no", async () => {
    await agregarArchivos([
      archivo("a.png", "image/png"),
      archivo("b.txt", "text/plain"),
      archivo("c.PDF", "application/pdf"),
    ]);
    const nombres = state.hojas.flatMap((h) => h.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(["a.png", "c p.1/1", null, null]);
  });

  it("acepta pdf por extensión aunque el type sea genérico", async () => {
    await agregarArchivos([archivo("doc.pdf", "application/octet-stream")]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it("crea el comprobante y la cola lo toma (procesando, sin avanzar)", async () => {
    await agregarArchivos([archivo("f.jpg", "image/jpeg")]);
    const c = state.hojas[0]?.slots[0];
    // pendiente→procesando es sincrónico; el sleep(900) queda congelado.
    expect(c?.estado).toBe("procesando");
    expect(c?.montoCents).toBeNull();
    expect(c?.textoOcr).toBe("");
    expect(c?.imgUrl).toContain("blob:mock-");
  });

  it("rellena huecos de la última hoja y desborda heredando layout", async () => {
    const h = crearHoja("u2h");
    h.slots[0] = comprobante();
    state.hojas.push(h);
    await agregarArchivos([1, 2, 3].map((n) => archivo(`${n}.png`, "image/png")));
    expect(state.hojas).toHaveLength(2);
    expect(state.hojas.every((x) => x.layout === "u2h")).toBe(true);
    const nombres = state.hojas.flatMap((x) => x.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(["factura.png", "1.png", "2.png", "3.png"]);
  });

  it("con hojaId rellena ESA hoja aunque otra tenga hueco", async () => {
    const a = crearHoja();
    const b = crearHoja();
    state.hojas.push(a, b);
    await agregarArchivos([archivo("x.png", "image/png")], b.id);
    expect(a.slots.every((c) => c === null)).toBe(true);
    expect(b.slots[0]?.nombre).toBe("x.png");
  });

  it("dispara la cola (flag sincrónico) sin avanzar con timers falsos", async () => {
    await agregarArchivos([archivo("f.png", "image/png")]);
    expect(state.colaEnProceso).toBe(true);
    expect(state.hojas[0]?.slots[0]?.estado).toBe("procesando");
  });
});

describe("fileInput / canvas / paste", () => {
  it("change del input agrega y resetea el value", async () => {
    Object.defineProperty(fileInput, "files", {
      value: [archivo("in.png", "image/png")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0); // el intake ahora es async
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
    expect(fileInput.value).toBe("");
  });

  it("dragenter con Files marca el canvas; dragleave limpia (contador)", () => {
    canvas.dispatchEvent(eventoDragenter());
    canvas.dispatchEvent(eventoDragenter()); // anidado: sigue marcado
    expect(canvas.classList.contains("arrastrando")).toBe(true);
    canvas.dispatchEvent(eventoDragleave());
    expect(canvas.classList.contains("arrastrando")).toBe(true);
    canvas.dispatchEvent(eventoDragleave());
    expect(canvas.classList.contains("arrastrando")).toBe(false);
  });

  it("sin Files no hay overlay ni preventDefault", () => {
    const e = eventoDragenter(["text/plain"]);
    canvas.dispatchEvent(e);
    expect(canvas.classList.contains("arrastrando")).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("en modo OCR la entrada sigue activa (overlay y subida)", async () => {
    state.modoOcr = true;
    try {
      canvas.dispatchEvent(eventoDragenter());
      expect(canvas.classList.contains("arrastrando")).toBe(true);
      canvas.dispatchEvent(eventoDrop([archivo("o.png", "image/png")]));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
    } finally {
      state.modoOcr = false;
    }
  });

  it("drop en el canvas agrega y limpia la marca", async () => {
    canvas.classList.add("arrastrando");
    // La tarjeta burbujea al canvas (igual que el fondo del área).
    el("dropzone").dispatchEvent(eventoDrop([archivo("d.png", "image/png")]));
    await vi.advanceTimersByTimeAsync(0); // el intake ahora es async
    expect(canvas.classList.contains("arrastrando")).toBe(false);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it("paste con archivo agrega; sin archivos no hace nada", async () => {
    document.dispatchEvent(eventoPaste([archivo("p.png", "image/png")]));
    await vi.advanceTimersByTimeAsync(0); // el intake ahora es async
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
    document.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });
});

describe("elegirArchivos (botón ＋ por hoja)", () => {
  it("usa showPicker si existe", () => {
    const show = vi.fn();
    Object.defineProperty(fileInput, "showPicker", { value: show, configurable: true });
    try {
      elegirArchivos(7);
      expect(show).toHaveBeenCalled();
    } finally {
      Object.defineProperty(fileInput, "showPicker", { value: undefined, configurable: true });
    }
  });

  it("sin showPicker usa click", () => {
    Object.defineProperty(fileInput, "showPicker", { value: undefined, configurable: true });
    const click = vi.spyOn(fileInput, "click").mockImplementation(() => {});
    elegirArchivos(7);
    expect(click).toHaveBeenCalled();
  });

  it("el change sube a la hoja pedida y resetea la pendiente", async () => {
    const a = crearHoja();
    const b = crearHoja();
    state.hojas.push(a, b);
    elegirArchivos(b.id); // sin showPicker en jsdom: click sin diálogo
    Object.defineProperty(fileInput, "files", {
      value: [archivo("h.png", "image/png")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.slots.some((c) => c?.nombre === "h.png")).toBe(true);
    expect(a.slots.every((c) => c === null)).toBe(true);
    // Pendiente consumida: el siguiente change vuelve a automático.
    Object.defineProperty(fileInput, "files", {
      value: [archivo("a.png", "image/png")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.slots.some((c) => c?.nombre === "a.png")).toBe(true);
  });

  it("cancelar el diálogo limpia la hoja pedida (el próximo intake es automático)", async () => {
    const a = crearHoja();
    const b = crearHoja();
    state.hojas.push(a, b);
    elegirArchivos(b.id);
    fileInput.dispatchEvent(new Event("cancel", { bubbles: true }));
    Object.defineProperty(fileInput, "files", {
      value: [archivo("c.png", "image/png")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.slots.some((c) => c?.nombre === "c.png")).toBe(true);
    expect(b.slots.every((c) => c === null)).toBe(true);
  });

  it("un intake con hoja propia consume la pedida (el próximo picker es automático)", async () => {
    const a = crearHoja();
    const b = crearHoja();
    state.hojas.push(a, b);
    elegirArchivos(b.id);
    await agregarArchivos([archivo("d.png", "image/png")], a.id); // drop sobre A
    expect(a.slots.some((c) => c?.nombre === "d.png")).toBe(true);
    Object.defineProperty(fileInput, "files", {
      value: [archivo("e.png", "image/png")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.slots.some((c) => c?.nombre === "e.png")).toBe(true);
    expect(b.slots.every((c) => c === null)).toBe(true);
  });
});

describe("gate PDF (tamaño + páginas)", () => {
  function pdfTamano(nombre: string, bytes: number): File {
    const f = archivo(nombre, "application/pdf");
    Object.defineProperty(f, "size", { value: bytes });
    return f;
  }

  it("pdf > 5 MB se rechaza con aviso y no entra", async () => {
    aviso.textContent = "";
    await agregarArchivos([pdfTamano("gordo.pdf", 6 * 1024 * 1024)]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(aviso.textContent).toContain("gordo.pdf");
    expect(aviso.textContent).toContain("5 MB");
  });

  it("pdf con > 10 páginas se rechaza con aviso", async () => {
    aviso.textContent = "";
    paginasSimuladas = 11;
    await agregarArchivos([archivo("largo.pdf", "application/pdf")]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(aviso.textContent).toContain("10 páginas");
  });

  it("pdf en el límite (10 páginas, 5 MB) entra", async () => {
    paginasSimuladas = 10;
    await agregarArchivos([pdfTamano("limite.pdf", 5 * 1024 * 1024)]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it("soltada mixta: entran los válidos, aviso por cada rechazo", async () => {
    aviso.textContent = "";
    await agregarArchivos([
      archivo("ok.png", "image/png"),
      pdfTamano("gordo.pdf", 6 * 1024 * 1024),
      archivo("vale.pdf", "application/pdf"),
    ]);
    const nombres = state.hojas.flatMap((h) => h.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(["ok.png", "vale p.1/1", null, null]);
    expect(aviso.textContent).toContain("gordo.pdf");
  });

  it("formato no soportado avisa sin entrar", async () => {
    aviso.textContent = "";
    await agregarArchivos([archivo("nota.txt", "text/plain")]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(aviso.textContent).toContain("formato no soportado");
  });

  it("el motivo va en .motivo (rojo sello) y el nombre en texto plano", async () => {
    aviso.textContent = "";
    await agregarArchivos([pdfTamano("gordo.pdf", 6 * 1024 * 1024)]);
    const m = aviso.querySelector(".motivo");
    expect(m?.textContent).toBe("pesa más de 5 MB");
    expect(m?.innerHTML).toBe("pesa más de 5 MB"); // sin marcado inyectado
  });

  it("lote válido limpia el aviso viejo de otro lote", async () => {
    aviso.textContent = "«gordo.pdf»: pesa más de 5 MB";
    await agregarArchivos([archivo("ok.png", "image/png")]);
    expect(aviso.textContent).toBe("");
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it("pdf de 3 páginas (1 blanca) → 2 comprobantes p.1/3 y p.3/3 con thumb", async () => {
    aviso.textContent = "";
    expansionSimulada = [paginaSimulada(1, 3), paginaSimulada(3, 3)];
    await agregarArchivos([archivo("fac.pdf", "application/pdf")]);
    const nombres = state.hojas.flatMap((h) => h.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(["fac p.1/3", "fac p.3/3", null, null]);
    const thumbs = state.hojas.flatMap((h) => h.slots.map((c) => c?.thumbUrl ?? null));
    expect(thumbs.slice(0, 2).every((t) => t?.startsWith("blob:mock-") ?? false)).toBe(true);
    expect(aviso.textContent).toBe("");
  });

  it("pdf todo en blanco → aviso sin comprobante", async () => {
    aviso.textContent = "";
    expansionSimulada = [];
    await agregarArchivos([archivo("vacio.pdf", "application/pdf")]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(aviso.textContent).toContain("no se pudo leer");
  });

  it("imagen blanca avisa sin entrar (el resto del lote sí)", async () => {
    aviso.textContent = "";
    fallosImagen.set("b.png", "blanca");
    await agregarArchivos([archivo("b.png", "image/png"), archivo("ok.png", "image/png")]);
    const nombres = state.hojas.flatMap((h) => h.slots.map((c) => c?.nombre ?? null));
    expect(nombres).toEqual(["ok.png", null, null, null]);
    expect(aviso.textContent).toContain("no se pudo leer");
  });

  it("imagen corrupta avisa sin entrar", async () => {
    aviso.textContent = "";
    fallosImagen.set("r.png", "ilegible");
    await agregarArchivos([archivo("r.png", "image/png")]);
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(aviso.textContent).toContain("no se pudo leer");
  });
});

describe("código de pedido", () => {
  function armar(): void {
    chkCodigo.checked = true;
    chkCodigo.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("switch ON arma sin escribir en LS y habilita el input", () => {
    renderCodigo();
    expect(inputCodigo.disabled).toBe(true);
    armar();
    expect(state.codigoActivo).toBe(true);
    expect(inputCodigo.disabled).toBe(false);
    expect(localStorage.getItem("libro-mayor-state")).toBeNull();
  });

  it("editar longitud/valor guarda solo armado; OFF retira el código", () => {
    armar();
    numCodigo.value = "8";
    numCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    inputCodigo.value = "12345678";
    inputCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    expect(JSON.parse(localStorage.getItem("libro-mayor-state") ?? "{}")).toMatchObject({
      codigoActivo: true,
      codigoLongitud: 8,
      codigoValor: "12345678",
    });

    chkCodigo.checked = false;
    chkCodigo.dispatchEvent(new Event("change", { bubbles: true }));
    expect(localStorage.getItem("libro-mayor-state")).toBeNull();

    numCodigo.value = "5";
    numCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    expect(localStorage.getItem("libro-mayor-state")).toBeNull();
  });

  it("longitud clamp 1..12 y fallback 6", () => {
    numCodigo.value = "99";
    numCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.codigoLongitud).toBe(12);
    expect(numCodigo.value).toBe("12");
    numCodigo.value = "abc";
    numCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.codigoLongitud).toBe(6);
  });

  it("valor deja solo dígitos y corta a la longitud", () => {
    state.codigoLongitud = 6;
    inputCodigo.value = "12ab3456789";
    inputCodigo.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.codigoValor).toBe("123456");
    expect(inputCodigo.value).toBe("123456");
  });

  function radios(): NodeListOf<HTMLInputElement> {
    return document.querySelectorAll<HTMLInputElement>('input[name="posCodigo"]');
  }

  function radio(valor: string): HTMLInputElement {
    const r = document.querySelector<HTMLInputElement>(`input[name="posCodigo"][value="${valor}"]`);
    if (!r) throw new Error(`sin radio ${valor}`);
    return r;
  }

  it("render marca la esquina del estado y la apaga con el switch", () => {
    state.codigoPosicion = "sup-izq";
    state.codigoActivo = true;
    renderCodigo();
    expect(radio("sup-izq").checked).toBe(true);
    expect(radio("inf-der").checked).toBe(false);
    radios().forEach((r) => expect(r.disabled).toBe(false));

    state.codigoActivo = false;
    renderCodigo();
    radios().forEach((r) => expect(r.disabled).toBe(true));
  });

  it("cambiar de esquina actualiza el estado y persiste solo armado", () => {
    armar();
    const r = radio("inf-izq");
    r.checked = true;
    r.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.codigoPosicion).toBe("inf-izq");
    expect(JSON.parse(localStorage.getItem("libro-mayor-state") ?? "{}")).toMatchObject({
      codigoPosicion: "inf-izq",
    });

    localStorage.clear();
    chkCodigo.checked = false;
    chkCodigo.dispatchEvent(new Event("change", { bubbles: true }));
    const r2 = radio("sup-der");
    r2.checked = true;
    r2.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.codigoPosicion).toBe("sup-der");
    expect(localStorage.getItem("libro-mayor-state")).toBeNull();
  });
});

describe("modalLimpiar", () => {
  it("confirmar vacía a una hoja fresca y revoca URLs", () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ imgUrl: "blob:img", thumbUrl: "blob:thumb" });
    h.slots[1] = comprobante({ imgUrl: "blob:img2", thumbUrl: null });
    state.hojas.push(h);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    modalLimpiar.returnValue = "ok";
    modalLimpiar.close();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]?.slots.every((c) => c === null)).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:img");
    expect(revoke).toHaveBeenCalledWith("blob:thumb");
    expect(revoke).toHaveBeenCalledWith("blob:img2");
  });

  it("cancelar no toca nada", () => {
    const h = crearHoja();
    h.slots[0] = comprobante();
    state.hojas.push(h);
    modalLimpiar.returnValue = "";
    modalLimpiar.close();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]).toBe(h);
  });
});
