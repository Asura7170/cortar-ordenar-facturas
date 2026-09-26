/* Tests P1: hojas — layouts, quitar, clic delegado, drop y celdas (DOM aislado). */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el, eventoDrop, eventoDragover, eventoDragleave } from "../test/fixture";

// El giro real toca canvas/blob: se aserta el cableado, no el pipeline.
vi.mock("../pipeline/rotar", () => ({ girarYReleer: vi.fn(async () => {}) }));
// El editor real abre un modal: se aserta el cableado, no el canvas.
vi.mock("./recorte", () => ({ abrirRecorte: vi.fn(async () => {}) }));
// El lote post-corregir no debe pegar a la red en tests.
vi.mock("../pipeline/extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));

montarFixture();
const { state, crearHoja } = await import("../state");
const {
  actualizarMontoCelda,
  aplicarATodas,
  cambiarLayoutHoja,
  esDragDeArchivos,
  esEcoDeRemocion,
  initSheets,
  quitarComprobante,
  renderHojas,
} = await import("./sheets");
const { archivo, comprobante } = await import("../test/factoria");
const { girarYReleer } = await import("../pipeline/rotar");
const { abrirRecorte } = await import("./recorte");
const { extraerPendientes } = await import("../pipeline/extract");
import type { Comprobante, Hoja, LayoutId } from "../types";

const agregarArchivos = vi.fn();
const pedirArchivos = vi.fn();
initSheets({ agregarArchivos, pedirArchivos });

afterEach(() => {
  vi.restoreAllMocks();
  agregarArchivos.mockClear();
  pedirArchivos.mockClear();
  vi.mocked(extraerPendientes).mockClear();
});

/** Polling con timeout (en vez de sleeps fijos: resuelve en cuanto se cumple). */
async function esperar(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Siembra una hoja con montos (null = casilla vacía) y la pinta. */
function sembrar(layout: LayoutId, montos: (number | null)[]): Hoja {
  const h = crearHoja(layout);
  h.slots = montos.map((m) => (m === null ? null : comprobante({ montoCents: m })));
  state.hojas.push(h);
  renderHojas();
  return h;
}

function boton(accion: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(`[data-accion="${accion}"]`);
  if (!b) throw new Error(`sin botón ${accion}`);
  return b;
}

/** Espera a que el import dinámico (clic → abrirRecorte) termine. */
async function vaciar(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("cambiarLayoutHoja / aplicarATodas", () => {
  it("ids inválidos no hacen nada", () => {
    const h = sembrar("u4x2", [10, 20]);
    cambiarLayoutHoja(-1, "u1");
    cambiarLayoutHoja(h.id, "bogus");
    expect(h.layout).toBe("u4x2");
    expect(state.hojas).toHaveLength(1);
  });

  it("achica y refluye: 4 items u4x2 → u1 deja 4 hojas", () => {
    const h = sembrar("u4x2", [1, 2, 3, 4]);
    cambiarLayoutHoja(h.id, "u1");
    expect(state.hojas).toHaveLength(4);
    expect(state.hojas.every((x) => x.slots.filter(Boolean).length <= 1)).toBe(true);
  });

  it("aplicarATodas propaga el layout origen", () => {
    const a = sembrar("u1", [10]);
    const b = crearHoja("u6x2");
    b.slots[0] = comprobante({ montoCents: 20 });
    state.hojas.push(b);
    renderHojas();
    aplicarATodas(a.id);
    expect(state.hojas.every((x) => x.layout === "u1")).toBe(true);
    expect(state.hojas.flatMap((x) => x.slots).filter(Boolean)).toHaveLength(2);
  });
});

describe("quitarComprobante", () => {
  it("quita, revoca img y elimina la hoja vaciada", () => {
    const a = sembrar("u4x2", [null]);
    const b = crearHoja();
    const c = comprobante({ imgUrl: "blob:img" });
    b.slots[0] = c;
    state.hojas.push(b);
    renderHojas();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    quitarComprobante(c.id);
    expect(a.slots.every((s) => s === null)).toBe(true);
    expect(state.hojas).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith("blob:img");
  });

  it("id inexistente no tira", () => {
    sembrar("u4x2", [10]);
    expect(() => quitarComprobante(-1)).not.toThrow();
    expect(state.hojas).toHaveLength(1);
  });
});

describe("clic delegado", () => {
  it("× quita el comprobante", () => {
    sembrar("u4x2", [100]);
    boton("quitar").click();
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(0);
    expect(el("dropzone").hidden).toBe(false);
  });

  it("cada hoja tiene su ＋ debajo del panel y pide archivos para esa hoja", () => {
    const h = sembrar("u4x2", [100]);
    const btn = document.querySelector<HTMLButtonElement>('.btn-sumar[data-accion="agregar"]');
    expect(btn?.dataset["hoja"]).toBe(String(h.id));
    expect(btn?.closest(".sheet-side")).not.toBeNull();
    expect(btn?.previousElementSibling?.classList.contains("sheet-panel")).toBe(true);
    btn?.click();
    expect(pedirArchivos).toHaveBeenCalledWith(h.id);
  });

  it("tarjeta de layout cambia la plantilla", () => {
    const h = sembrar("u4x2", [100]);
    document.querySelector<HTMLButtonElement>('.grid-opt[data-layout="u1"]')?.click();
    expect(h.layout).toBe("u1");
  });

  it("aplicar a todas desde el panel", () => {
    sembrar("u1", [10]);
    const b = crearHoja("u6x2");
    b.slots[0] = comprobante();
    state.hojas.push(b);
    renderHojas();
    boton("apply-all").click();
    expect(new Set(state.hojas.map((x) => x.layout)).size).toBe(1);
  });

  it("⧉ copia el OCR solo si hay texto (y solo existe en modo OCR)", () => {
    state.modoOcr = true;
    const h = crearHoja();
    h.slots[0] = comprobante({ textoOcr: "HOLA" });
    h.slots[1] = comprobante({ textoOcr: "" });
    state.hojas.push(h);
    renderHojas();
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const botones = [...document.querySelectorAll<HTMLButtonElement>('[data-accion="copiar-ocr"]')];
    expect(botones).toHaveLength(2);
    botones[0]?.click();
    expect(write).toHaveBeenCalledWith("HOLA");
    write.mockClear();
    botones[1]?.click();
    expect(write).not.toHaveBeenCalled();
  });

  it("⧉ sin clipboard API (http): marca fallo sin tirar", () => {
    state.modoOcr = true;
    const h = crearHoja();
    h.slots[0] = comprobante({ textoOcr: "HOLA" });
    state.hojas.push(h);
    renderHojas();
    const real = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      const btn = boton("copiar-ocr");
      expect(() => btn.click()).not.toThrow();
      expect(btn.title).toContain("Copiar falló");
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: real, configurable: true });
    }
  });

  it("⧉ writeText que rechaza marca fallo", async () => {
    state.modoOcr = true;
    const h = crearHoja();
    h.slots[0] = comprobante({ textoOcr: "HOLA" });
    state.hojas.push(h);
    renderHojas();
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("denegado"));
    const btn = boton("copiar-ocr");
    btn.click();
    await esperar(() => btn.title.includes("Copiar falló"));
    expect(write).toHaveBeenCalledWith("HOLA");
    expect(btn.title).toContain("Copiar falló");
  });

  it("sin modo OCR no hay botón ⧉", () => {
    sembrar("u4x2", [100]);
    expect(document.querySelector('[data-accion="copiar-ocr"]')).toBeNull();
  });
});

describe("celdas", () => {
  it("ocupada tabindex 0, vacía -1", () => {
    sembrar("u4x2", [100, null, null, null]);
    const tabs = [...document.querySelectorAll(".cell")].map((c) => (c as HTMLElement).tabIndex);
    expect(tabs).toEqual([0, -1, -1, -1]);
  });

  it("badge con el monto formateado", () => {
    state.moneda = "USD";
    sembrar("u4x2", [123456]);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 1,234.56");
  });

  it("pinta el full-res de la celda", () => {
    const h = sembrar("u4x2", [null]);
    const c = comprobante({ imgUrl: "blob:full", file: archivo("f.png", "image/png") });
    h.slots[0] = c;
    renderHojas();
    expect(document.querySelector<HTMLImageElement>(".cell img")?.src).toContain("blob:full");
  });

  it("actualizarMontoCelda pinta el badge sin tocar la imagen", () => {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: null });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    const cell = document.querySelector(".cell");
    const imgAntes = cell?.querySelector("img");
    expect(imgAntes).not.toBeNull();
    c.montoCents = 1250; // como lo deja aplicarTotales
    expect(actualizarMontoCelda(c.id)).toBe(true);
    expect(document.querySelector(".cell-badge")?.textContent).toContain("12.50");
    expect(document.querySelector("input.cell-monto")).toBeNull();
    expect(cell?.querySelector("img")).toBe(imgAntes);
  });

  it("actualizarMontoCelda no pisa el input enfocado", () => {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: null });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    document.querySelector<HTMLInputElement>("input.cell-monto")?.focus();
    c.montoCents = 1250;
    expect(actualizarMontoCelda(c.id)).toBe(false);
    expect(document.querySelector("input.cell-monto")).not.toBeNull();
    expect(document.querySelector(".cell-badge")).toBeNull();
  });

  it("actualizarMontoCelda no pisa el borrador sin foco", () => {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: null });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    // La celda propia es la última (el rebuild pinta en orden de hojas).
    const celdas = document.querySelectorAll(".cell");
    const cell = celdas.item(celdas.length - 1);
    if (!(cell instanceof HTMLElement)) throw new Error("sin celda propia");
    const input = cell.querySelector("input.cell-monto");
    if (!(input instanceof HTMLInputElement)) throw new Error("sin input de monto");
    input.value = "abc"; // borrador inválido tras blur, sin foco
    c.montoCents = 1250; // como lo deja aplicarTotales
    expect(actualizarMontoCelda(c.id)).toBe(false);
    expect(cell.querySelector("input.cell-monto")).not.toBeNull();
    expect(cell.querySelector(".cell-badge")).toBeNull();
  });

  it("actualizarMontoCelda early-returns: modoOcr, id inexistente y monto null", () => {
    state.modoOcr = true;
    try {
      expect(actualizarMontoCelda(999999)).toBe(false);
    } finally {
      state.modoOcr = false;
    }
    expect(actualizarMontoCelda(999999)).toBe(false);
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: null });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    expect(actualizarMontoCelda(c.id)).toBe(false);
  });

  it("con loteEnCurso no usa ViewTransition (sin snapshots)", () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "startViewTransition");
    const spy = vi.fn((cb: () => void): Record<string, unknown> => {
      cb();
      return {};
    });
    Object.defineProperty(document, "startViewTransition", { value: spy, configurable: true });
    try {
      sembrar("u1", [100]);
      spy.mockClear();
      state.loteEnCurso = true;
      renderHojas();
      expect(spy).not.toHaveBeenCalled();
      state.loteEnCurso = false;
      renderHojas();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      state.loteEnCurso = false;
      if (descriptor) Object.defineProperty(document, "startViewTransition", descriptor);
      else Reflect.deleteProperty(document, "startViewTransition");
    }
  });
});

describe("monto manual", () => {
  /** Tarjeta ok sin monto (lo que deja la cola sin LLM). */
  function sembrarOk(): Comprobante {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: null });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    return c;
  }

  function inputMonto(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>("input.cell-monto");
    if (!input) throw new Error("sin input de monto");
    return input;
  }

  it("tarjeta ok sin monto muestra input con etiqueta", () => {
    sembrarOk();
    expect(inputMonto().getAttribute("aria-label")).toContain("factura.png");
  });

  it("pendiente sin monto no muestra input", () => {
    sembrar("u1", [null]);
    expect(document.querySelector("input.cell-monto")).toBeNull();
  });

  it("change válido fija el monto, lo marca manual y pinta badge", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "1234.56";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBe(123456);
    expect(c.montoManual).toBe(true);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 1,234.56");
    expect(document.querySelector("input.cell-monto")).toBeNull();
  });

  it("change inválido conserva el borrador sin robar el foco", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "abc";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBeNull();
    const deNuevo = inputMonto();
    expect(deNuevo.value).toBe("abc");
    // ponytail: el blur no reenfoca (solo Enter); el foco sigue donde lo dejó el usuario.
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(deNuevo);
  });

  it("esEcoDeRemocion: desatachado es eco, atachado con foco no", () => {
    sembrarOk();
    const input = inputMonto();
    input.value = "777";
    input.focus();
    expect(esEcoDeRemocion(input)).toBe(false);
    input.remove();
    // ponytail: jsdom no dispara change por remoción (el guard real se cubre
    // en E2E Chrome); acá se regresiona el predicado, que es lo testeable.
    expect(esEcoDeRemocion(input)).toBe(true);
  });

  it("render de fondo no commitea ni pisa el borrador enfocado", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "45";
    input.focus();
    renderHojas();
    expect(c.montoCents).toBeNull();
    expect(c.montoManual).toBe(false);
    const deNuevo = inputMonto();
    expect(deNuevo.value).toBe("45");
    expect(document.activeElement).toBe(deNuevo);
  });

  it("clic en badge abre edición con el valor previo, foco y sin reintento IA", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "500";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBe(50000);
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    // ponytail: apertura no destructiva (el null al abrir era el bug del Escape).
    expect(c.montoCents).toBe(50000);
    const deNuevo = document.querySelector<HTMLInputElement>("input.cell-monto");
    expect(deNuevo?.value).toBe("500.00");
    expect(document.activeElement).toBe(deNuevo);
    expect(deNuevo?.selectionStart).toBe(0);
    expect(deNuevo?.selectionEnd).toBe(deNuevo?.value.length);
    // ponytail: la IA solo entra por subida/botón/giro, nunca por corregir.
    expect(vi.mocked(extraerPendientes)).not.toHaveBeenCalled();
  });

  it("Escape sin escribir restaura el badge con el valor previo", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    inputMonto().value = "500";
    inputMonto().dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    inputMonto().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(c.montoCents).toBe(50000);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 500.00");
    expect(document.querySelector("input.cell-monto")).toBeNull();
  });

  it("Escape tras escribir descarta el borrador y conserva el previo", () => {
    const c = sembrarOk();
    inputMonto().value = "500";
    inputMonto().dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    const editando = inputMonto();
    editando.value = "510.5";
    editando.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(c.montoCents).toBe(50000);
    expect(editando.isConnected).toBe(false);
  });

  it("borrador inválido sin foco sobrevive a un render de fondo", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "abc";
    input.blur();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    renderHojas(); // cola/mini pintando de fondo sin foco en el input
    expect(inputMonto().value).toBe("abc");
    expect(c.montoCents).toBeNull();
    expect(document.activeElement).not.toBe(inputMonto());
  });

  it("Enter con prefill de miles sin cambios conserva el valor exacto", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    inputMonto().value = "1111";
    inputMonto().dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBe(111100);
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    // ponytail: el prefill con coma de miles debe hacer roundtrip por parsearMonto.
    expect(inputMonto().value).toBe("1,111.00");
    inputMonto().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(c.montoCents).toBe(111100);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 1,111.00");
  });

  it("Enter con edición confirma el nuevo valor en el badge", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    inputMonto().value = "500";
    inputMonto().dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    const editando = inputMonto();
    editando.value = "510.5";
    editando.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(c.montoCents).toBe(51050);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 510.50");
    expect(document.activeElement).toBe(document.querySelector(".cell-badge"));
  });

  it("inválido en corrección conserva el tipeado sin tocar el previo ni reenfocar", () => {
    const c = sembrarOk();
    inputMonto().value = "500";
    inputMonto().dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLElement>(".cell-badge")?.click();
    const editando = inputMonto();
    editando.value = "abc";
    editando.blur(); // el foco ya salió (clic fuera): el change no lo trae de vuelta
    editando.dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBe(50000);
    const deNuevo = inputMonto();
    expect(deNuevo.value).toBe("abc");
    expect(document.activeElement).toBe(document.body);
  });

  it("render de fondo preserva borrador, foco y caret", () => {
    sembrarOk();
    const input = inputMonto();
    input.value = "12.5";
    input.focus();
    input.setSelectionRange(2, 2);
    renderHojas(); // p. ej. la cola pintando otro ítem
    const deNuevo = inputMonto();
    expect(deNuevo.value).toBe("12.5");
    expect(document.activeElement).toBe(deNuevo);
    expect(deNuevo.selectionStart).toBe(2);
  });

  it("Enter confirma y deja el foco en el badge", () => {
    state.moneda = "USD";
    sembrarOk();
    const input = inputMonto();
    input.value = "99.99";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 99.99");
    expect(document.activeElement).toBe(document.querySelector(".cell-badge"));
  });

  it("Escape descarta el borrador y enfoca la celda", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "12.5";
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(c.montoCents).toBeNull();
    const deNuevo = inputMonto();
    expect(deNuevo.value).toBe("");
    expect(document.activeElement).toBe(deNuevo.closest(".cell"));
  });

  it("Escape con drag abierto cancela sin commitear", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "12.5";
    input.focus();
    document.querySelector(".cell img")?.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      }),
    );
    expect(document.querySelector(".sheet-grid.dragging")).not.toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // ponytail: con drag activo el render se difería y el foco a la celda
    // commiteaba el borrador vía change (el Esc confirmaba en vez de cancelar).
    expect(c.montoCents).toBeNull();
    expect(inputMonto().value).toBe("");
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
  });

  it("pointerdown en el input no inicia drag (foco intacto)", () => {
    sembrarOk();
    const ev = Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    inputMonto().dispatchEvent(ev);
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("pointerdown en la imagen sí inicia drag (control)", () => {
    sembrarOk();
    const img = document.querySelector(".cell img");
    if (!img) throw new Error("sin imagen");
    img.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      }),
    );
    expect(document.querySelector(".sheet-grid.dragging")).not.toBeNull();
    document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
  });

  it("Enter inválido conserva el borrador y reenfoca sin robar", () => {
    sembrarOk();
    const input = inputMonto();
    input.value = "abc";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(inputMonto().value).toBe("abc");
    expect(document.querySelector(".cell-badge")).toBeNull();
  });

  it("sin nodo previo el badge se agrega a la celda", () => {
    const c = sembrarOk();
    renderHojas();
    const cell = document.querySelector(".cell");
    if (!(cell instanceof HTMLElement)) throw new Error("sin celda");
    cell.querySelector("input.cell-monto")?.remove();
    c.montoCents = 1250;
    expect(actualizarMontoCelda(c.id)).toBe(true);
    expect(cell.querySelector(".cell-badge")?.textContent).toContain("12.50");
  });

  it("tecla M escribiendo no alterna la lupa", () => {
    sembrarOk();
    const btn = document.querySelector<HTMLButtonElement>("#btnLupa");
    inputMonto().dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "m" }),
    );
    expect(btn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("monto entero se muestra con 2 decimales (500 → US$ 500.00)", () => {
    state.moneda = "USD";
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "500";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(c.montoCents).toBe(50000);
    expect(document.querySelector(".cell-badge")?.textContent).toBe("US$ 500.00");
  });
});

describe("drop de archivos sobre hojas", () => {
  it("esDragDeArchivos detecta Files", () => {
    const con = { dataTransfer: { types: ["Files"] } } as unknown as DragEvent;
    const sin = { dataTransfer: { types: ["text/plain"] } } as unknown as DragEvent;
    const vacio = {} as DragEvent;
    expect(esDragDeArchivos(con)).toBe(true);
    expect(esDragDeArchivos(sin)).toBe(false);
    expect(esDragDeArchivos(vacio)).toBe(false);
  });

  it("drop delega al callback con el id de la hoja", () => {
    const h = sembrar("u4x2", [100]);
    const files = [new File(["x"], "d.png", { type: "image/png" })];
    document.querySelector(".sheet")?.dispatchEvent(eventoDrop(files));
    expect(agregarArchivos).toHaveBeenCalledWith(files, h.id);
  });

  it("en modo OCR el drop sigue activo (la entrada nunca se bloquea)", () => {
    state.modoOcr = true;
    try {
      const h = sembrar("u4x2", [100]);
      const files = [new File(["x"], "d.png", { type: "image/png" })];
      document.querySelector(".sheet")?.dispatchEvent(eventoDrop(files));
      expect(agregarArchivos).toHaveBeenCalledWith(files, h.id);
    } finally {
      state.modoOcr = false;
    }
  });

  it("dragover con Files resalta la hoja; sin Files no", () => {
    sembrar("u4x2", [100]);
    const sheet = document.querySelector(".sheet");
    if (!sheet) throw new Error("sin .sheet");
    sheet.dispatchEvent(eventoDragover());
    expect(sheet.classList.contains("file-drop")).toBe(true);
    sheet.classList.remove("file-drop");
    const e = eventoDragover(["text/plain"]);
    sheet.dispatchEvent(e);
    expect(sheet.classList.contains("file-drop")).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("dragover entre hojas mueve el resaltado; la zona muerta no scrollea", () => {
    sembrar("u1", [10]);
    sembrar("u1", [20]);
    const hojas = [...document.querySelectorAll(".sheet")];
    // Canvas con alto real: clientY=400 cae en la zona muerta del autoscroll.
    const rect = vi.spyOn(el("canvas"), "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    try {
      const sobre = (sheet: Element, y: number): void => {
        sheet.dispatchEvent(
          Object.assign(new Event("dragover", { bubbles: true, cancelable: true }), {
            dataTransfer: { files: [], types: ["Files"] },
            clientX: 10,
            clientY: y,
          }),
        );
      };
      sobre(hojas[0] as Element, 10);
      expect((hojas[0] as Element).classList.contains("file-drop")).toBe(true);
      sobre(hojas[1] as Element, 400);
      expect((hojas[0] as Element).classList.contains("file-drop")).toBe(false);
      expect((hojas[1] as Element).classList.contains("file-drop")).toBe(true);
    } finally {
      rect.mockRestore();
    }
  });

  it("dragleave quita el resaltado y para el scroll", () => {
    sembrar("u1", [10]);
    const sheet = document.querySelector(".sheet");
    if (!(sheet instanceof HTMLElement)) throw new Error("sin .sheet");
    sheet.dispatchEvent(
      Object.assign(new Event("dragover", { bubbles: true, cancelable: true }), {
        dataTransfer: { files: [], types: ["Files"] },
        clientX: 10,
        clientY: 10,
      }),
    );
    expect(sheet.classList.contains("file-drop")).toBe(true);
    sheet.dispatchEvent(Object.assign(eventoDragleave(), { relatedTarget: document.body }));
    expect(sheet.classList.contains("file-drop")).toBe(false);
  });

  it("scroll invalida el caché de rects sin tirar", () => {
    sembrar("u4x2", [100]);
    expect(() => el("canvas").dispatchEvent(new Event("scroll"))).not.toThrow();
  });
});

describe("zoom ctrl+rueda (layout, scroll sincronizado)", () => {
  // Red ante asserts que fallen a mitad: cada test parte sin zoom.
  afterEach(() => {
    el<HTMLButtonElement>("btnZoom").click();
  });

  function rueda(ctrl: boolean): boolean {
    const e = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: ctrl,
      deltaY: -100,
      clientX: 50,
      clientY: 50,
    });
    el("canvas").dispatchEvent(e);
    return e.defaultPrevented;
  }

  it("sin ctrl no toca el zoom (scroll nativo intacto)", () => {
    rueda(false);
    expect(el("sheets").style.getPropertyValue("zoom")).toBe("");
    expect(el<HTMLButtonElement>("btnZoom").hidden).toBe(true);
  });

  it("con ctrl aplica zoom, muestra el % y el botón restaura", () => {
    expect(rueda(true)).toBe(true);
    const sheets = el("sheets");
    const btn = el<HTMLButtonElement>("btnZoom");
    expect(sheets.style.getPropertyValue("zoom")).not.toBe("");
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(sheets.style.getPropertyValue("zoom")).toBe("");
    expect(btn.hidden).toBe(true);
  });

  it("botones +/− siempre visibles y aplican zoom centrado", () => {
    const mas = el<HTMLButtonElement>("btnZoomMas");
    const menos = el<HTMLButtonElement>("btnZoomMenos");
    const sheets = el("sheets");
    const btn = el<HTMLButtonElement>("btnZoom");
    expect(mas.hidden).toBe(false);
    expect(menos.hidden).toBe(false);
    mas.click();
    expect(sheets.style.getPropertyValue("zoom")).not.toBe("");
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(sheets.style.getPropertyValue("zoom")).toBe("");
    expect(btn.hidden).toBe(true);
  });

  it("Ctrl+0 restaura el zoom por teclado", () => {
    rueda(true);
    expect(el("sheets").style.getPropertyValue("zoom")).not.toBe("");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "0" }),
    );
    expect(el("sheets").style.getPropertyValue("zoom")).toBe("");
    expect(el<HTMLButtonElement>("btnZoom").hidden).toBe(true);
  });

  it("Ctrl++/Ctrl+- ajustan por teclado", () => {
    const sheets = el("sheets");
    const btn = el<HTMLButtonElement>("btnZoom");
    const tecla = (key: string): void => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key }),
      );
    };
    tecla("=");
    expect(sheets.style.getPropertyValue("zoom")).not.toBe("");
    tecla("=");
    expect(sheets.style.getPropertyValue("zoom")).not.toBe("");
    tecla("-");
    expect(btn.hidden).toBe(false);
  });
});

describe("lupa", () => {
  // Red ante asserts que fallen a mitad: cada test parte con la lupa apagada.
  afterEach(() => {
    const apagado = el<HTMLButtonElement>("btnLupa");
    if (apagado.getAttribute("aria-pressed") === "true") apagado.click();
  });

  it("el botón alterna y Escape la cierra", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    const lupa = el("lupa");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    // Sin muestra aún: oculta hasta que el puntero entre al canvas.
    expect(lupa.style.opacity).toBe("0");
    el("canvas").dispatchEvent(
      Object.assign(new Event("pointermove", { bubbles: true }), {
        clientX: 200,
        clientY: 200,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(lupa.style.opacity).toBe("0");
  });

  it("la lente se centra en el puntero (lo reemplaza)", async () => {
    el<HTMLButtonElement>("btnLupa").click();
    el("canvas").dispatchEvent(
      Object.assign(new Event("pointermove", { bubbles: true }), {
        clientX: 200,
        clientY: 200,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(el("lupa").style.transform).toBe("translate(100px, 100px)");
    el<HTMLButtonElement>("btnLupa").click();
  });

  it("el primer clic izquierdo la apaga y traga ese clic", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    document.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerType: "mouse",
      }),
    );
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    const tragado = new Event("click", { bubbles: true, cancelable: true });
    document.dispatchEvent(tragado);
    expect(tragado.defaultPrevented).toBe(true);
    const libre = new Event("click", { bubbles: true, cancelable: true });
    document.dispatchEvent(libre);
    expect(libre.defaultPrevented).toBe(false);
  });

  it("el grupo zoom no apaga la lupa (coexiste con ella)", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    const mas = el<HTMLButtonElement>("btnZoomMas");
    btn.click();
    mas.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerType: "mouse",
      }),
    );
    mas.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(el("sheets").style.getPropertyValue("zoom")).not.toBe("");
    btn.click();
    el<HTMLButtonElement>("btnZoom").click();
    expect(el("sheets").style.getPropertyValue("zoom")).toBe("");
  });

  it("un press sin clic no envenena el próximo clic", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    btn.click();
    const press = (x: number): void => {
      document.dispatchEvent(
        Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
          button: 0,
          isPrimary: true,
          pointerType: "mouse",
          clientX: x,
          clientY: 10,
        }),
      );
    };
    press(10); // apaga la lupa y arma la supresión…
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    press(20); // …pero el clic nunca llega (soltar fuera): se purga
    const libre = new Event("click", { bubbles: true, cancelable: true });
    document.dispatchEvent(libre);
    expect(libre.defaultPrevented).toBe(false);
  });

  it("M alterna la lupa", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    const tecla = (key: string): void => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }),
      );
    };
    tecla("m");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    tecla("m");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("pointerleave oculta y pointerenter restaura la muestra", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    const zona = el("canvas");
    const mover = (tipo: string): void => {
      zona.dispatchEvent(
        Object.assign(new Event(tipo, { bubbles: true }), { clientX: 200, clientY: 200 }),
      );
    };
    mover("pointerenter"); // apagada: no hace nada
    expect(el("lupa").style.opacity).toBe("0");
    btn.click();
    mover("pointermove");
    mover("pointerleave");
    expect(el("lupa").style.opacity).toBe("0");
    mover("pointerenter");
    expect(el("lupa").style.opacity).toBe("1");
  });

  it("keydown y pointercancel purgan la supresión (click posterior pasa)", () => {
    const btn = el<HTMLButtonElement>("btnLupa");
    const press = (): void => {
      document.dispatchEvent(
        Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
          button: 0,
          isPrimary: true,
          pointerType: "mouse",
        }),
      );
    };
    const clicPasa = (): boolean => {
      const c = new Event("click", { bubbles: true, cancelable: true });
      document.dispatchEvent(c);
      return !c.defaultPrevented;
    };
    btn.click();
    press(); // apaga y arma la supresión…
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    // …pero un keydown (click de teclado en camino) la purga:
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(clicPasa()).toBe(true);
    btn.click();
    press(); // rearma…
    document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    expect(clicPasa()).toBe(true); // …gesto abortado: nada que tragar
  });
});

describe("giro manual", () => {
  /** Tarjeta ok en modo imagen (no se decodifica en el test). */
  function sembrarGirable(): Comprobante {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok" });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    return c;
  }

  function botonGiro(accion: "girar-izq" | "girar-der"): HTMLButtonElement {
    const b = document.querySelector<HTMLButtonElement>(`[data-accion="${accion}"]`);
    if (!b) throw new Error(`sin botón ${accion}`);
    return b;
  }

  it("botones ⟲⟳ solo en celda ok en modo imagen", () => {
    sembrar("u1", [100]); // pendiente: sin botones
    expect(document.querySelector('[data-accion="girar-izq"]')).toBeNull();
    sembrarGirable();
    expect(botonGiro("girar-izq").getAttribute("aria-label")).toBe("Girar a la izquierda");
    expect(botonGiro("girar-der").getAttribute("aria-label")).toBe("Girar a la derecha");
  });

  it("botón ✂ solo en celda ok en modo imagen", () => {
    sembrar("u1", [100]); // pendiente: sin botón
    expect(document.querySelector('[data-accion="recortar"]')).toBeNull();
    sembrarGirable();
    const b = document.querySelector<HTMLButtonElement>('[data-accion="recortar"]');
    expect(b?.getAttribute("aria-label")).toBe("Recortar comprobante");
    expect(b?.classList.contains("cell-recortar")).toBe(true);
  });

  it("en modo OCR no hay botones de giro", () => {
    state.modoOcr = true;
    try {
      sembrarGirable();
      expect(document.querySelector('[data-accion="girar-izq"]')).toBeNull();
    } finally {
      state.modoOcr = false;
    }
  });

  it("clic delega a girarYReleer con el id y los grados", () => {
    const c = sembrarGirable();
    botonGiro("girar-izq").click();
    expect(vi.mocked(girarYReleer)).toHaveBeenCalledWith(c.id, 270);
    botonGiro("girar-der").click();
    expect(vi.mocked(girarYReleer)).toHaveBeenCalledWith(c.id, 90);
  });

  it("clic justo tras cerrar el editor no reabre (anti-resurrección)", async () => {
    vi.mocked(abrirRecorte).mockClear();
    const c = sembrarGirable();
    state.cierreRecorte = Date.now();
    try {
      boton("recortar").click();
      await vaciar();
      expect(vi.mocked(abrirRecorte)).not.toHaveBeenCalled();
      state.cierreRecorte = Date.now() - 1000;
      boton("recortar").click();
      await vaciar();
      expect(vi.mocked(abrirRecorte)).toHaveBeenCalledWith(c.id);
    } finally {
      state.cierreRecorte = 0;
    }
  });

  it("el resto acciona pese al cierre reciente (guard solo en recortar)", () => {
    vi.mocked(girarYReleer).mockClear();
    const c = sembrarGirable();
    state.cierreRecorte = Date.now();
    try {
      botonGiro("girar-izq").click();
      expect(vi.mocked(girarYReleer)).toHaveBeenCalledWith(c.id, 270);
    } finally {
      state.cierreRecorte = 0;
    }
  });

  it("corregir-monto abre edición con el valor previo y sin reintento IA", () => {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", montoCents: 500, montoManual: true });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    const badge = document.querySelector<HTMLButtonElement>('[data-accion="corregir-monto"]');
    if (!badge) throw new Error("sin badge corregir-monto");
    badge.click();
    // ponytail: apertura no destructiva (el null al abrir era el bug del Escape).
    expect(c.montoCents).toBe(500);
    const input = document.querySelector<HTMLInputElement>("input.cell-monto");
    expect(input?.value).toBe("5.00");
    expect(document.activeElement).toBe(input);
    // ponytail: la IA solo entra por subida/botón/giro, nunca por corregir.
    expect(vi.mocked(extraerPendientes)).not.toHaveBeenCalled();
  });

  it("corregir-monto fuera de ok no hace nada", () => {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "procesando", montoCents: 500 });
    h.slots[0] = c;
    state.hojas.push(h);
    renderHojas();
    document.querySelector<HTMLButtonElement>('[data-accion="corregir-monto"]')?.click();
    expect(c.montoCents).toBe(500);
    expect(document.querySelector('[data-accion="corregir-monto"]')).not.toBeNull();
    expect(document.querySelector("input.cell-monto")).toBeNull();
  });

  it("pointerdown en girar no inicia drag", () => {
    sembrarGirable();
    const ev = Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    botonGiro("girar-izq").dispatchEvent(ev);
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("drag: render pendiente y cancelaciones", () => {
  function pressImg(x = 10, y = 10): void {
    const img = document.querySelector(".cell img");
    if (!img) throw new Error("sin imagen");
    img.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  function moverDoc(x: number, y: number): void {
    document.dispatchEvent(
      Object.assign(new Event("pointermove", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  function soltarDoc(x: number, y: number): void {
    document.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  it("render durante el drag se pospone hasta soltar", () => {
    sembrar("u4x2", [100]);
    pressImg();
    renderHojas(); // pospuesto: la grilla no se reconstruye en arrastre
    soltarDoc(10, 10);
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
    expect(state.hojas.flatMap((h) => h.slots).filter(Boolean)).toHaveLength(1);
  });

  it("doble pointerdown reinicia el drag", () => {
    sembrar("u4x2", [100]);
    pressImg();
    pressImg();
    expect(document.querySelector(".sheet-grid.dragging")).not.toBeNull();
    soltarDoc(10, 10);
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
  });

  it("movimiento mínimo no activa y soltar no mueve", () => {
    const h = sembrar("u4x2", [100, 200]);
    pressImg();
    moverDoc(11, 11);
    soltarDoc(11, 11);
    expect(h.slots.map((c) => c?.montoCents)).toEqual([100, 200]);
  });

  it("lostpointercapture cierra el drag", () => {
    sembrar("u4x2", [100]);
    pressImg();
    el("sheets").dispatchEvent(
      Object.assign(new Event("lostpointercapture", { bubbles: true }), { isPrimary: true }),
    );
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
  });

  it("Escape con drag iniciado cancela", () => {
    sembrar("u4x2", [100]);
    pressImg();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
    );
    expect(document.querySelector(".sheet-grid.dragging")).toBeNull();
  });
});

describe("drag entre celdas (swap)", () => {
  /** Geometría determinista: celdas en fila de 100px + matchMedia para saltar el FLIP. */
  function stubGeometria(flip = true, vuelos?: number[]): () => void {
    const mm = (window as unknown as Record<string, unknown>)["matchMedia"];
    (window as unknown as Record<string, unknown>)["matchMedia"] = vi.fn(() => ({
      matches: flip,
    }));
    // jsdom no trae Element.animate: se define por test (el FLIP la llama si el vuelo supera 2px).
    Object.defineProperty(Element.prototype, "animate", {
      value: vi.fn(() => {
        vuelos?.push(1);
      }),
      configurable: true,
      writable: true,
    });
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const cells = [...document.querySelectorAll(".cell")];
      const host = this.closest?.(".cell") ?? this;
      const i = cells.indexOf(host as Element);
      const left = i < 0 ? 0 : i * 120;
      return {
        left,
        top: 0,
        width: 100,
        height: 100,
        right: left + 100,
        bottom: 100,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    return () => {
      rect.mockRestore();
      delete (Element.prototype as unknown as Record<string, unknown>)["animate"];
      if (mm === undefined) delete (window as unknown as Record<string, unknown>)["matchMedia"];
      else (window as unknown as Record<string, unknown>)["matchMedia"] = mm;
    };
  }

  /** Espera N frames reales (los rAF pendientes van primero: moveRaf/paso corren antes de volver). */
  async function esperarRaf(n = 2): Promise<void> {
    for (let i = 0; i < n; i++) {
      await new Promise<void>((r) => {
        requestAnimationFrame(() => r());
      });
    }
  }

  function pressCelda(idx: number, x: number, y: number): void {
    const img = document.querySelectorAll(".cell img").item(idx);
    if (!(img instanceof Element)) throw new Error("sin imagen");
    img.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  function moverDoc(x: number, y: number): void {
    document.dispatchEvent(
      Object.assign(new Event("pointermove", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  function soltarDoc(x: number, y: number): void {
    document.dispatchEvent(
      Object.assign(new Event("pointerup", { bubbles: true, cancelable: true }), {
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  /** jsdom no trae elementFromPoint: se define por test y se borra al salir. */
  function stubPunto(valor: Element | null): () => void {
    Object.defineProperty(document, "elementFromPoint", {
      value: vi.fn(() => valor),
      configurable: true,
    });
    return () => {
      delete (document as unknown as Record<string, unknown>)["elementFromPoint"];
    };
  }

  it("soltar sobre otra celda intercambia", async () => {
    const restaurar = stubGeometria();
    const punto = stubPunto(null);
    try {
      const h = sembrar("u4x2", [100, 200]);
      pressCelda(0, 10, 10);
      moverDoc(170, 50);
      await esperarRaf(); // moveRaf: resalta destino + autoscroll en vuelo
      moverDoc(171, 51);
      soltarDoc(170, 50);
      expect(h.slots.map((c) => c?.montoCents)).toEqual([200, 100]);
      expect(document.querySelector(".drag-ghost")).toBeNull();
    } finally {
      punto();
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });

  it("soltar en la misma celda no mueve", async () => {
    const restaurar = stubGeometria();
    try {
      const h = sembrar("u4x2", [100, 200]);
      const origen = document.querySelectorAll(".cell").item(0);
      const punto = stubPunto(origen as Element);
      try {
        pressCelda(0, 10, 10);
        moverDoc(170, 50);
        await esperarRaf(); // moveRaf: el destino propio se anula
        soltarDoc(170, 50);
        expect(h.slots.map((c) => c?.montoCents)).toEqual([100, 200]);
      } finally {
        punto();
      }
    } finally {
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });

  it("soltar lejos no mueve (sin celda cercana)", () => {
    const restaurar = stubGeometria();
    const punto = stubPunto(null);
    try {
      const h = sembrar("u4x2", [100, 200]);
      pressCelda(0, 10, 10);
      moverDoc(170, 50);
      soltarDoc(9999, 9999);
      expect(h.slots.map((c) => c?.montoCents)).toEqual([100, 200]);
    } finally {
      punto();
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });

  it("mover con dueño muerto no resucita", () => {
    const restaurar = stubGeometria();
    const punto = stubPunto(null);
    try {
      const a = sembrar("u1", [100]);
      const b = sembrar("u1", [200]);
      pressCelda(0, 10, 10);
      moverDoc(170, 50);
      state.hojas = [b];
      soltarDoc(170, 50);
      expect(b.slots.map((c) => c?.montoCents)).toEqual([200]);
      expect(
        state.hojas.flatMap((h) => h.slots).find((c) => c?.id === a.slots[0]?.id),
      ).toBeUndefined();
    } finally {
      punto();
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });

  it("salida estructural repinta completo", () => {
    const restaurar = stubGeometria();
    const punto = stubPunto(null);
    try {
      sembrar("u1", [100]);
      const b = sembrar("u4x2", [200, null]);
      pressCelda(0, 10, 10);
      moverDoc(290, 50);
      soltarDoc(290, 50);
      expect(state.hojas).toHaveLength(1);
      expect(b.slots.map((c) => c?.montoCents)).toEqual([200, 100]);
    } finally {
      punto();
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });

  it("flip centrado no anima (soltar en el centro)", () => {
    // matches:false = sin reduced-motion: pasa el gate y llega al chequeo de distancia.
    const vuelos: number[] = [];
    const restaurar = stubGeometria(false, vuelos);
    const punto = stubPunto(null);
    try {
      const h = sembrar("u4x2", [100, 200]);
      pressCelda(0, 10, 10);
      moverDoc(170, 50);
      soltarDoc(170, 50); // centro exacto de la celda destino: dx=dy=0
      expect(h.slots.map((c) => c?.montoCents)).toEqual([200, 100]);
      // imgA salta por hypot<2 y solo imgB vuela: sin el guard serían 2.
      expect(vuelos).toHaveLength(1);
    } finally {
      punto();
      restaurar();
      document.dispatchEvent(new Event("pointercancel", { bubbles: true }));
    }
  });
});
