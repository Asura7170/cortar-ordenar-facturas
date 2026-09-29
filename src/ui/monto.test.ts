/* Tests P0: montos en cents y colecciones (monto.ts necesita #montoTotal al importar). */
import { describe, expect, it } from "vite-plus/test";

document.body.innerHTML = '<div id="montoTotal"></div><button id="btnIA" type="button"></button>';
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

  it("odómetro: solo rueda lo que cambia, rápido a la derecha", () => {
    state.moneda = "USD";
    const montoEl = document.getElementById("montoTotal");
    if (!montoEl) throw new Error("sin #montoTotal");
    hojaCon([10000]);
    renderMonto(); // sincroniza el previo
    hojaCon([25000]); // +250.00 → sube
    renderMonto();
    expect(montoEl.textContent).toBe("US$ 350.00");
    expect(montoEl.dataset["dir"]).toBe("-1");
    const rodillos = montoEl.querySelectorAll(".monto-rodillo");
    expect(rodillos).toHaveLength(2);
    const tiraAlta = rodillos[0]?.querySelector<HTMLSpanElement>(".monto-desplaza");
    const tiraBaja = rodillos[1]?.querySelector<HTMLSpanElement>(".monto-desplaza");
    expect(tiraAlta?.style.getPropertyValue("--p")).toBe("5");
    expect(tiraBaja?.style.getPropertyValue("--p")).toBe("4");
    expect(tiraAlta?.dataset["viejo"]).toBe("1");
    expect([...(tiraAlta?.children ?? [])].map((c) => c.textContent)).toEqual(["3"]);
    expect(montoEl.querySelector(".monto-nuevo")).toBeNull();
    state.hojas.pop(); // -250.00 → baja con tira invertida
    renderMonto();
    expect(montoEl.textContent).toBe("US$ 100.00");
    expect(montoEl.dataset["dir"]).toBe("1");
    const tiraBajada = montoEl
      .querySelector(".monto-rodillo")
      ?.querySelector<HTMLSpanElement>(".monto-desplaza");
    expect(tiraBajada?.dataset["viejo"]).toBe("3");
    expect([...(tiraBajada?.children ?? [])].map((c) => c.textContent)).toEqual(["1"]);
    renderMonto(); // duplicada → no-op, preserva los rodillos
    expect(montoEl.querySelectorAll(".monto-rodillo")).toHaveLength(2);
    state.moneda = "ARS"; // mismo total, otro texto → plano sin rodillos
    renderMonto();
    expect(montoEl.textContent).toBe("AR$ 100.00");
    expect(montoEl.querySelector(".monto-rodillo")).toBeNull();
    expect(montoEl.dataset["dir"]).toBeUndefined();
  });

  it("al crecer la cifra lo nuevo entra con pop y lo común rueda", () => {
    state.moneda = "USD";
    const montoEl = document.getElementById("montoTotal");
    if (!montoEl) throw new Error("sin #montoTotal");
    hojaCon([99999]);
    renderMonto(); // sincroniza el previo (US$ 999.99)
    hojaCon([100]); // +1.00 → US$ 1,000.99
    renderMonto();
    expect(montoEl.textContent).toBe("US$ 1,000.99");
    expect(montoEl.querySelectorAll(".monto-nuevo")).toHaveLength(2);
    expect(montoEl.querySelectorAll(".monto-rodillo")).toHaveLength(3);
  });

  it("al encoger la cifra el punto decimal no rueda", () => {
    state.moneda = "USD";
    const montoEl = document.getElementById("montoTotal");
    if (!montoEl) throw new Error("sin #montoTotal");
    hojaCon([100099]);
    renderMonto(); // US$ 1,000.99
    state.hojas = [];
    hojaCon([99999]);
    renderMonto(); // US$ 999.99
    expect(montoEl.textContent).toBe("US$ 999.99");
    expect(montoEl.querySelectorAll(".monto-rodillo").length).toBeGreaterThan(0);
    const viejos = [...montoEl.querySelectorAll<HTMLSpanElement>(".monto-desplaza")].map(
      (t) => t.dataset["viejo"],
    );
    expect(viejos).not.toContain(".");
  });
});

describe("barraBoton", () => {
  function botonIA(): HTMLButtonElement {
    const b = document.getElementById("btnIA");
    if (!(b instanceof HTMLButtonElement)) throw new Error("sin #btnIA");
    return b;
  }

  it("siempre visible: 0/0, mitad y lleno", () => {
    state.moneda = "USD";
    const btn = botonIA();
    renderMonto(); // sin hojas
    expect(btn.textContent).toBe("Calcular totales");
    expect(btn.style.getPropertyValue("--progreso")).toBe("0");
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    h.slots[1] = comprobante({ estado: "ok", textoOcr: "TOTAL 7" });
    state.hojas.push(h);
    renderMonto();
    expect(btn.textContent).toBe("Montos extraídos: 1/2");
    expect(btn.style.getPropertyValue("--progreso")).toBe("0.5");
  });

  it("añadir sin monto encoge la barra sin tocar el total", () => {
    state.moneda = "USD";
    const btn = botonIA();
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    state.hojas.push(h);
    renderMonto();
    expect(btn.textContent).toBe("Montos extraídos: 1/1");
    h.slots[1] = comprobante({ estado: "ok", textoOcr: "TOTAL 7" });
    renderMonto(); // mismo total: el odómetro no se toca…
    expect(document.getElementById("montoTotal")?.textContent).toBe("US$ 5.00");
    expect(btn.textContent).toBe("Montos extraídos: 1/2"); // …pero la barra sí se mueve
    expect(btn.style.getPropertyValue("--progreso")).toBe("0.5");
  });
});

describe("parsearMonto", () => {
  it("US: miles con coma, decimal con punto, plano", () => {
    expect(parsearMonto("1,234.56")).toBe(123456);
    expect(parsearMonto("1234.56")).toBe(123456);
    expect(parsearMonto("1,234,567.89")).toBe(123456789);
    expect(parsearMonto("500")).toBe(50000);
    expect(parsearMonto("12.5")).toBe(1250);
    expect(parsearMonto("  $ 1,234.56 ")).toBe(123456);
  });

  it("inválidos → null", () => {
    expect(parsearMonto("")).toBeNull();
    expect(parsearMonto("abc")).toBeNull();
    expect(parsearMonto("1234,56")).toBeNull(); // coma decimal EU: solo vale punto
    expect(parsearMonto("1,234")).toBeNull(); // miles sin decimales: escribir 1234
    expect(parsearMonto("12.345")).toBeNull();
    expect(parsearMonto("-5")).toBeNull();
    expect(parsearMonto("1,,234.56")).toBeNull(); // grupo vacío
    expect(parsearMonto("1.234.56")).toBeNull(); // mismo separador en miles y decimal
    expect(parsearMonto("1,234,56")).toBeNull(); // grupo de 2
    expect(parsearMonto("1.2.3")).toBeNull(); // grupo de 1
    expect(parsearMonto("12,34.56")).toBeNull(); // grupo de 2
  });
});
