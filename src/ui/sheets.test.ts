/* Tests P1: hojas — layouts, quitar, clic delegado, drop y celdas (DOM aislado). */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el, eventoDrop, eventoDragover } from "../test/fixture";

// El giro real toca canvas/blob: se aserta el cableado, no el pipeline.
vi.mock("../pipeline/rotar", () => ({ girarYReleer: vi.fn(async () => {}) }));
// El lote post-corregir no debe pegar a la red en tests.
vi.mock("../pipeline/extract", () => ({ extraerPendientes: vi.fn(async () => {}) }));

montarFixture();
const { state, crearHoja } = await import("../state");
const {
  actualizarMiniatura,
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
  it("quita, revoca img+thumb y elimina la hoja vaciada", () => {
    const a = sembrar("u4x2", [null]);
    const b = crearHoja();
    const c = comprobante({ imgUrl: "blob:img", thumbUrl: "blob:thumb" });
    b.slots[0] = c;
    state.hojas.push(b);
    renderHojas();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    quitarComprobante(c.id);
    expect(a.slots.every((s) => s === null)).toBe(true);
    expect(state.hojas).toHaveLength(1);
    expect(revoke).toHaveBeenCalledWith("blob:img");
    expect(revoke).toHaveBeenCalledWith("blob:thumb");
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

  it("actualizarMiniatura pinta el thumb sin reconstruir", () => {
    const h = sembrar("u4x2", [null]);
    // Con file de imagen y sin thumb: esqueleto, sin <img>.
    const c = comprobante({ imgUrl: "blob:full", file: archivo("f.png", "image/png") });
    h.slots[0] = c;
    renderHojas();
    expect(document.querySelector(".cell img")).toBeNull();
    c.thumbUrl = "blob:thumb";
    actualizarMiniatura(c.id);
    expect(document.querySelector<HTMLImageElement>(".cell img")?.src).toContain("blob:thumb");
  });

  it("actualizarMiniatura con id inexistente no tira", () => {
    sembrar("u4x2", [100]);
    expect(() => actualizarMiniatura(-1)).not.toThrow();
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

  it("miniatura en vuelo no commitea ni pisa el borrador enfocado", () => {
    const c = sembrarOk();
    const input = inputMonto();
    input.value = "45";
    input.focus();
    c.thumbUrl = "blob:thumb-nueva";
    actualizarMiniatura(c.id);
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
  /** Tarjeta ok en modo imagen (thumb falso: no se decodifica en el test). */
  function sembrarGirable(): Comprobante {
    const h = crearHoja("u1");
    const c = comprobante({ estado: "ok", thumbUrl: "blob:thumb" });
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
