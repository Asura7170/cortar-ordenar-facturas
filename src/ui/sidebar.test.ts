/* Tests P1: sidebar — entrada de archivos, código de pedido y limpiar (DOM aislado). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el, eventoDrop, eventoDragover, eventoPaste } from "../test/fixture";
import type { PaginaPdf } from "../pipeline/pdf";

// El conteo real abre el PDF con pdf.js: stub fijo (cada test lo ajusta).
let paginasSimuladas = 5;
// El raster real necesita Chrome: expansión stub (cada test la ajusta).
function paginaSimulada(indice: number, total: number): PaginaPdf {
  return { indice, total, blob: new Blob(["x"], { type: "image/webp" }) };
}
let expansionSimulada: PaginaPdf[] = [paginaSimulada(1, 1)];
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
const { agregarArchivos, initSidebar, renderCodigo } = await import("./sidebar");
const { archivo, comprobante } = await import("../test/factoria");

const dropzone = el("dropzone");
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

describe("fileInput / dropzone / paste", () => {
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

  it("dragover marca la zona y previene el default; dragleave limpia", () => {
    dropzone.dispatchEvent(eventoDragover());
    expect(dropzone.classList.contains("dragover")).toBe(true);
    dropzone.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(dropzone.classList.contains("dragover")).toBe(false);
  });

  it("drop agrega los archivos y limpia la marca", async () => {
    dropzone.classList.add("dragover");
    dropzone.dispatchEvent(eventoDrop([archivo("d.png", "image/png")]));
    await vi.advanceTimersByTimeAsync(0); // el intake ahora es async
    expect(dropzone.classList.contains("dragover")).toBe(false);
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
