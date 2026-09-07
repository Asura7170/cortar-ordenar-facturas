/* Tests P0: montos en cents y colecciones (monto.ts necesita #montoTotal al importar). */
import { describe, expect, it } from "vite-plus/test";

document.body.innerHTML = '<div id="montoTotal"></div>';
const { state, crearHoja } = await import("../state");
const {
  aplanar,
  cuentaHoja,
  formatearMoneda,
  itemsDe,
  parsearMonto,
  renderMonto,
  sumaTotal,
  totalItems,
} = await import("./monto");
const { comprobante } = await import("../test/factoria");
import type { Hoja } from "../types";

function hojaCon(montos: (number | null)[]): Hoja {
  const h = crearHoja("u6x2");
  h.slots = montos.map((m) => (m === null ? null : comprobante({ montoCents: m })));
  state.hojas.push(h);
  return h;
}

describe("formatearMoneda", () => {
  it("formato en-US con 2 decimales y miles", () => {
    state.moneda = "USD";
    expect(formatearMoneda(123456)).toBe("US$ 1,234.56");
    expect(formatearMoneda(0)).toBe("US$ 0.00");
  });

  it("cents exactos: 5 cents son US$ 0.05 (nunca float)", () => {
    state.moneda = "USD";
    expect(formatearMoneda(5)).toBe("US$ 0.05");
    expect(formatearMoneda(10) + formatearMoneda(20)).not.toContain("0.30000000000000004");
  });

  it("símbolos por moneda", () => {
    state.moneda = "ARS";
    expect(formatearMoneda(100)).toBe("AR$ 1.00");
    state.moneda = "EUR";
    expect(formatearMoneda(100)).toBe("€ 1.00");
    state.moneda = "BOB";
    expect(formatearMoneda(100)).toBe("Bs 1.00");
  });
});

describe("colecciones", () => {
  it("itemsDe/cuentaHoja ignoran huecos", () => {
    const h = hojaCon([100, null, 200]);
    expect(itemsDe(h)).toHaveLength(2);
    expect(cuentaHoja(h)).toBe(2);
  });

  it("aplanar preserva el orden visual entre hojas", () => {
    const a = hojaCon([10, 20]);
    const b = hojaCon([30]);
    expect(aplanar()).toEqual([...itemsDe(a), ...itemsDe(b)]);
  });

  it("sumaTotal trata null como 0 y totalItems solo cuenta ocupados", () => {
    hojaCon([100, null, 250]);
    expect(sumaTotal()).toBe(350);
    expect(totalItems()).toBe(2);
  });
});

describe("renderMonto", () => {
  it("escribe el total formateado en #montoTotal", () => {
    state.moneda = "USD";
    hojaCon([123456]);
    renderMonto();
    expect(document.getElementById("montoTotal")?.textContent).toBe("US$ 1,234.56");
  });
});

describe("parsearMonto", () => {
  it("US con miles, plano y coma decimal", () => {
    expect(parsearMonto("1,234.56")).toBe(123456);
    expect(parsearMonto("1234.56")).toBe(123456);
    expect(parsearMonto("1234,56")).toBe(123456);
    expect(parsearMonto("500")).toBe(50000);
    expect(parsearMonto("12.5")).toBe(1250);
    expect(parsearMonto("  $ 1,234.56 ")).toBe(123456);
  });

  it("inválidos → null", () => {
    expect(parsearMonto("")).toBeNull();
    expect(parsearMonto("abc")).toBeNull();
    expect(parsearMonto("1,234")).toBeNull(); // miles sin decimales: escribir 1234
    expect(parsearMonto("12.345")).toBeNull();
    expect(parsearMonto("-5")).toBeNull();
    expect(parsearMonto("1,,234.56")).toBeNull(); // grupo vacío
    expect(parsearMonto("1.2.3")).toBeNull(); // grupo de 1
    expect(parsearMonto("12,34.56")).toBeNull(); // grupo de 2
  });
});
