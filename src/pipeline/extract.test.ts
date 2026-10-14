/* Tests: extract.ts — regex offline, lo manual siempre gana. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn(), actualizarMontoCelda: vi.fn() }));

montarFixture();
const { crearHoja, state } = await import("../state");
const { comprobante } = await import("../test/factoria");
const { renderHojas, actualizarMontoCelda } = await import("../ui/sheets");
const {
  aplicarTotales,
  candidatos,
  computarLote,
  extractCandidates,
  extraerPendientes,
  extraerRapidoCents,
  limpiarTextoCompleto,
  mensajeLote,
} = await import("./extract");
import type { ItemLote } from "./extract";

const aviso = el("aviso");

function lote2(): { c1: ReturnType<typeof comprobante>; c2: ReturnType<typeof comprobante> } {
  const h = crearHoja();
  const c1 = comprobante({ nombre: "factura (2).png", estado: "ok", textoOcr: "TOTAL 12.50" });
  const c2 = comprobante({ nombre: "otra.png", estado: "ok", textoOcr: "TOTAL 7.00" });
  h.slots[0] = c1;
  h.slots[1] = c2;
  state.hojas.push(h);
  return { c1, c2 };
}

beforeEach(() => {
  state.hojas = [];
  state.colaEnProceso = false;
  aviso.textContent = "";
  vi.mocked(renderHojas).mockClear();
  vi.mocked(actualizarMontoCelda).mockReset().mockReturnValue(true);
});

describe("candidatos", () => {
  it("solo ok + null + con texto (manual y pendientes fuera)", () => {
    const h = crearHoja();
    const ok = comprobante({ estado: "ok", textoOcr: "TOTAL 5" });
    h.slots[0] = ok;
    h.slots[1] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    h.slots[2] = comprobante({ estado: "ok", textoOcr: "   " });
    h.slots[3] = comprobante({ estado: "pendiente", textoOcr: "TOTAL 5" });
    state.hojas.push(h);
    expect(candidatos()).toEqual([ok]);
  });

  it("marca manual: fuera aunque esté en null", () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoManual: true });
    state.hojas.push(h);
    expect(candidatos()).toEqual([]);
  });
});

describe("regex", () => {
  it("filtra cuentas sin decimal e ignora precios ×4 decimales", () => {
    expect(extractCandidates("Bs 18,490.34 Cuenta 40005189200").map((c) => c.valor)).toEqual([
      "18,490.34",
    ]);
    expect(extractCandidates("x Bs 8.2500 = Bs 1,650.00").map((c) => c.valor)).toEqual([
      "1,650.00",
    ]);
  });

  it("rápido: 1 distinto resuelve, repetido vale, 2 distintos = manual", () => {
    expect(extraerRapidoCents("TOTAL 12.50")).toBe(1250);
    expect(extraerRapidoCents("TOTAL 1,234.56 ... total 1234.56")).toBe(123456);
    expect(extraerRapidoCents("TOTAL 12.50 PROPINA 1.00")).toBeNull();
    expect(extraerRapidoCents("sin montos")).toBeNull();
  });

  it("rápido: 1 solo aunque huela a parcial es ok (no se pide etiqueta TOTAL)", () => {
    expect(extraerRapidoCents("SUBTOTAL 45.00")).toBe(4500);
    expect(extraerRapidoCents("1.23")).toBe(123);
  });

  it("rápido clasifica sobre el texto completo (TOTAL tras el char 1800 cuenta)", () => {
    const largo = `SUBTOTAL 45.00 ${"x ".repeat(1000)}TOTAL 50.00`;
    expect(largo.length).toBeGreaterThan(1800);
    expect(extraerRapidoCents(largo)).toBeNull(); // 2 distintos → manual
    expect(extraerRapidoCents(`TOTAL 50.00 ${"x ".repeat(1000)}`)).toBe(5000);
  });

  it("rápido rechaza signo previo (nota de crédito queda manual)", () => {
    expect(extraerRapidoCents("TOTAL -12.50")).toBeNull();
    expect(extraerRapidoCents("TOTAL (12.50)")).toBeNull();
    expect(extraerRapidoCents("TOTAL 12.50")).toBe(1250);
  });

  it("guiones separadores no cuentan como signo (resuelve; el simple sí)", () => {
    expect(extraerRapidoCents("TOTAL ---------- 12.50")).toBe(1250);
    expect(extraerRapidoCents("TOTAL ---- 12.50")).toBe(1250);
    expect(extraerRapidoCents("TOTAL - 12.50")).toBeNull();
  });

  it("limpiarTextoCompleto colapsa espacios sin capar", () => {
    expect(limpiarTextoCompleto("  TOTAL   12.50\n\nIVA 1 ")).toBe("TOTAL 12.50 IVA 1");
    expect(limpiarTextoCompleto("x".repeat(5000))).toHaveLength(5000);
  });
});

describe("aplicarTotales", () => {
  it("manual fijado en el ínterin gana (sigue en null al aplicar)", () => {
    const { c1 } = lote2();
    c1.montoCents = 9999; // el usuario escribió mientras corría la pasada
    const n = aplicarTotales([{ idx: 1, id: c1.id, texto: "x" }], new Map([[1, 4200]]));
    expect(n).toBe(0);
    expect(c1.montoCents).toBe(9999);
  });

  it("comprobante quitado en el ínterin no resucita", () => {
    const h = crearHoja();
    const c = comprobante({ estado: "ok", textoOcr: "TOTAL 1" });
    h.slots[0] = c;
    state.hojas.push(h);
    state.hojas = [crearHoja()];
    const n = aplicarTotales([{ idx: 1, id: c.id, texto: "x" }], new Map([[1, 100]]));
    expect(n).toBe(0);
  });

  it("texto cambiado en el ínterin (giro manual): no aplica el rancio", () => {
    const { c1 } = lote2();
    const items: ItemLote[] = [{ idx: 1, id: c1.id, texto: "TOTAL 12.50" }];
    c1.textoOcr = "TOTAL 99.99"; // girado a mitad de la pasada
    expect(aplicarTotales(items, new Map([[1, 1250]]))).toBe(0);
    expect(c1.montoCents).toBeNull();
  });

  it("borrador en edición gana a la pasada en vuelo (input enfocado)", () => {
    const { c1 } = lote2();
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset["id"] = String(c1.id);
    const input = document.createElement("input");
    input.className = "cell-monto";
    input.dataset["accion"] = "monto";
    cell.append(input);
    document.body.append(cell);
    input.focus();
    try {
      const items: ItemLote[] = [{ idx: 1, id: c1.id, texto: "TOTAL 12.50" }];
      expect(aplicarTotales(items, new Map([[1, 4200]]))).toBe(0);
      expect(c1.montoCents).toBeNull();
    } finally {
      cell.remove();
    }
  });

  it("borrador inválido sin foco gana a la pasada (tipeado tras blur)", () => {
    const { c1 } = lote2();
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset["id"] = String(c1.id);
    const input = document.createElement("input");
    input.className = "cell-monto";
    input.dataset["accion"] = "monto";
    input.value = "abc";
    cell.append(input);
    document.body.append(cell);
    try {
      const items: ItemLote[] = [{ idx: 1, id: c1.id, texto: "TOTAL 12.50" }];
      expect(aplicarTotales(items, new Map([[1, 4200]]))).toBe(0);
      expect(c1.montoCents).toBeNull();
    } finally {
      cell.remove();
    }
  });

  it("input vacío sin foco no frena la pasada (control: sigue autofill)", () => {
    const { c1 } = lote2();
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset["id"] = String(c1.id);
    const input = document.createElement("input");
    input.className = "cell-monto";
    input.dataset["accion"] = "monto";
    cell.append(input);
    document.body.append(cell);
    try {
      const items: ItemLote[] = [{ idx: 1, id: c1.id, texto: "TOTAL 12.50" }];
      expect(aplicarTotales(items, new Map([[1, 4200]]))).toBe(1);
      expect(c1.montoCents).toBe(4200);
    } finally {
      cell.remove();
    }
  });
});

describe("computarLote", () => {
  it("sin candidatos → sin-candidatos", () => {
    expect(computarLote([])).toEqual({ tipo: "sin-candidatos" });
  });

  it("candidatos sin texto → sin-texto", () => {
    expect(computarLote([comprobante({ textoOcr: "   " })])).toEqual({ tipo: "sin-texto" });
  });

  it("sin montos → sin-totales", () => {
    const c = comprobante({ textoOcr: "recorte malo sin números" });
    expect(computarLote([c])).toEqual({ tipo: "sin-totales" });
  });

  it("listo mapea idx/id/texto y el mapa de totales", () => {
    const c1 = comprobante({ textoOcr: "TOTAL 12.50" });
    const c2 = comprobante({ textoOcr: "TOTAL 7.00" });
    expect(computarLote([c1, c2])).toEqual({
      tipo: "listo",
      items: [
        { idx: 1, id: c1.id, texto: "TOTAL 12.50" },
        { idx: 2, id: c2.id, texto: "TOTAL 7.00" },
      ],
      mapa: new Map([
        [1, 1250],
        [2, 700],
      ]),
    });
  });
});

describe("mensajeLote", () => {
  it("éxito total con aviso previo lo restaura", () => {
    expect(mensajeLote(2, 2, "«gordo.pdf»: pesa más de 5 MB")).toBe(
      "«gordo.pdf»: pesa más de 5 MB",
    );
  });

  it("éxito total sin aviso previo informa el conteo", () => {
    expect(mensajeLote(2, 2, "  ")).toBe("Local: 2/2 totales.");
  });

  it("parcial informa el conteo aunque haya aviso previo", () => {
    expect(mensajeLote(1, 2, "previo")).toBe("Local: 1/2 totales.");
  });
});

describe("extraerPendientes", () => {
  it("auto: 1 pasada, pinta 1 vez y avisa el conteo", () => {
    const { c1, c2 } = lote2();
    extraerPendientes();
    expect(c1.montoCents).toBe(1250);
    expect(c2.montoCents).toBe(700);
    expect(vi.mocked(renderHojas)).toHaveBeenCalledTimes(1);
    expect(aviso.textContent).toBe("Local: 2/2 totales.");
  });

  it("la pasada mueve la barra global con-monto/total", async () => {
    const { renderMonto } = await import("../ui/monto");
    lote2();
    const btn = el<HTMLButtonElement>("btnCalcular");
    renderMonto();
    expect(btn.textContent).toBe("Calcular totales");
    expect(btn.style.getPropertyValue("--progreso")).toBe("0");
    extraerPendientes();
    renderMonto(); // la app lo hace vía renderHojas (mockeado aquí)
    expect(btn.textContent).toBe("Montos extraídos: 2/2");
    expect(btn.style.getPropertyValue("--progreso")).toBe("1");
  });

  it("≥2 distintos: sin forzado silencioso, con forzado avisa revisión manual", () => {
    const { c1, c2 } = lote2();
    c1.textoOcr = "SUBTOTAL 45.00 TOTAL 50.00"; // 2 distintos → manual
    c2.textoOcr = "SUBTOTAL 45.00 TOTAL 60.00";
    extraerPendientes();
    expect(c1.montoCents).toBeNull();
    expect(c2.montoCents).toBeNull();
    expect(aviso.textContent).toBe("");
    extraerPendientes({ forzado: true });
    expect(aviso.textContent).toBe("Sin totales para leer: revisá manualmente o recortá de nuevo.");
  });

  it("éxito total conserva el aviso previo (N1)", () => {
    const { c1 } = lote2();
    aviso.textContent = "«gordo.pdf»: pesa más de 5 MB";
    extraerPendientes();
    expect(c1.montoCents).toBe(1250);
    expect(aviso.textContent).toBe("«gordo.pdf»: pesa más de 5 MB");
  });

  it("auto bloqueado durante OCR salvo desdeCola (regresión)", () => {
    const { c1 } = lote2();
    state.colaEnProceso = true;
    try {
      extraerPendientes();
      expect(c1.montoCents).toBeNull();
      expect(aviso.textContent).toBe("");
      extraerPendientes({ desdeCola: true });
      expect(c1.montoCents).toBe(1250);
    } finally {
      state.colaEnProceso = false;
    }
  });

  it("sin texto legible y forzado avisa revisión manual", () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "recorte malo sin números" });
    h.slots[0] = c1;
    state.hojas.push(h);
    extraerPendientes({ forzado: true });
    expect(c1.montoCents).toBeNull();
    expect(aviso.textContent).toBe("Sin totales para leer: revisá manualmente o recortá de nuevo.");
  });

  it("todo ya con total o manual: forzado avisa sin pendientes", () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    state.hojas.push(h);
    extraerPendientes({ forzado: true });
    expect(aviso.textContent).toBe("Sin pendientes (todo ya tiene total o es manual).");
  });

  it("forzado durante OCR avisa que se calcula al terminar", () => {
    const { c1 } = lote2();
    state.colaEnProceso = true;
    try {
      extraerPendientes({ forzado: true });
      expect(c1.montoCents).toBeNull();
      expect(aviso.textContent).toBe("OCR en curso: los totales se calculan al terminar.");
    } finally {
      state.colaEnProceso = false;
    }
  });

  it("parcial con forzado: avisa conteo y resto manual", () => {
    lote2();
    const amb = state.hojas[0]?.slots[1];
    if (amb) amb.textoOcr = "PROPINA 1.00 TOTAL 7.00"; // 2 distintos → manual
    extraerPendientes({ forzado: true });
    expect(aviso.textContent).toBe("Local: 1/2 totales.");
  });

  it("sin nodo de aviso no tira (aviso previo vacío)", () => {
    const { c1 } = lote2();
    const nodo = document.getElementById("aviso");
    if (!nodo) throw new Error("sin #aviso en el fixture");
    nodo.remove();
    try {
      extraerPendientes();
      expect(c1.montoCents).toBe(1250);
    } finally {
      document.body.append(nodo); // mismo nodo: la const aviso sigue válida
    }
  });
});
