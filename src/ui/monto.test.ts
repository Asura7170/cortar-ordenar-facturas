/* Tests P0: montos en cents y colecciones (monto.ts necesita #montoTotal al importar). */

import { describe, expect, it } from "vite-plus/test";

import type { Hoja } from "../types";

document.body.innerHTML =
  '<div id="montoTotal"></div><button id="btnCalcular" type="button"></button><button id="btnWord" type="button"></button><button id="btnPdf" type="button"></button><button id="btnImprimir" type="button"></button><button id="btnLimpiar" type="button"></button>';
const { state, crearHoja } = await import("../state");
const {
  aplanar,
  celdaDesdeMatriz,
  cuentaHoja,
  desplazamiento,
  formatearMoneda,
  itemsDe,
  parsearMonto,
  pasos,
  pasoDesde,
  prefijoComun,
  alinearSufijos,
  spanFijo,
  renderMonto,
  sumaTotal,
  totalItems,
} = await import("./monto");
const { comprobante } = await import("../test/factoria");

function hojaCon(montos: (number | null)[]): Hoja {
  const h = crearHoja("u6x2");
  h.slots = montos.map((m) => (m === null ? null : comprobante({ montoCents: m })));
  state.hojas.push(h);
  return h;
}

describe("formatearMoneda", () => {
  it("formato en-US con 2 decimales y miles", () => {
    state.moneda = "USD";
    expect(formatearMoneda(123_456)).toBe("US$ 1,234.56");
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
    expect(aplanar()).toStrictEqual([...itemsDe(a), ...itemsDe(b)]);
  });

  it("sumaTotal trata null como 0 y totalItems solo cuenta ocupados", () => {
    hojaCon([100, null, 250]);
    expect(sumaTotal()).toBe(350);
    expect(totalItems()).toBe(2);
  });
});

describe("pasos", () => {
  it("subir avanza hacia arriba con 1 barrido extra", () => {
    // 4→…→0 cruzando el 9: 1 paso + 1 barrido
    expect(pasos(9, 0, true)).toBe(11);
    expect(pasos(0, 1, true)).toBe(11);
    expect(pasos(3, 7, true)).toBe(14);
  });

  it("bajar desplaza negativo (simétrico)", () => {
    expect(pasos(0, 9, false)).toBe(-11);
    expect(pasos(3, 1, false)).toBe(-12);
  });

  it("mismo dígito todavía marca el barrido completo (el llamador lo salta)", () => {
    expect(pasos(4, 4, true)).toBe(20);
  });
});

describe("pasoDesde", () => {
  it("continuación: camina desde donde está la ruleta, con el signo del delta", () => {
    // el arranque que antes bajaba (14→1) ya camina arriba
    expect(pasoDesde(14, 1, true)).toBe(7);
    // ya está en el objetivo ⇒ estática
    expect(pasoDesde(11, 1, true)).toBe(0);
    // baja camina hacia abajo
    expect(pasoDesde(5, 1, false)).toBe(-4);
    // 6→…→12: aterriza en 2 (8 células arriba)
    expect(pasoDesde(6, 2, true)).toBe(6);
  });
});

describe("desplazamiento y aterrizaje", () => {
  it("desplazamiento rebasa por el origen de la tira (regresión del 8 inicial)", () => {
    // plano "0": la tira arranca en k=-2 y la célula 0 queda en la 3ª posición
    expect(desplazamiento(-2, 0, 24)).toBe(-48);
    // aterrizaje del 9→0 sube (base 7, fin 20)
    expect(desplazamiento(7, 20, 24)).toBe(-312);
    // baja: célula -9 visible con base -11 (2ª posición)
    expect(desplazamiento(-11, -9, 24)).toBe(-48);
  });

  it("celdaDesdeMatriz: matriz computada → célula; basura → null (fallback)", () => {
    expect(celdaDesdeMatriz("matrix(1, 0, 0, 1, 0, -48)", -2, 24)).toBe(0);
    expect(celdaDesdeMatriz("matrix(1, 0, 0, 1, 0, -96)", -2, 24)).toBe(2);
    expect(celdaDesdeMatriz("none", -2, 24)).toBeNull();
    expect(celdaDesdeMatriz("", 0, 24)).toBeNull();
    // regresión: Number("") es 0 y devolvía `base` en vez de null
    expect(celdaDesdeMatriz("matrix()", 0, 24)).toBeNull();
    expect(celdaDesdeMatriz("matrix( )", 0, 24)).toBeNull();
  });
});

describe("renderMonto", () => {
  function cols(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("#montoTotal .monto-col")];
  }
  function tiraDe(c: HTMLElement): HTMLElement {
    const t = c.querySelector<HTMLElement>(".monto-tira");
    if (!t) {
      throw new Error("sin tira");
    }
    return t;
  }

  it("total legible en aria-label; plano: cada dígito clavado en su número", () => {
    state.moneda = "USD";
    hojaCon([123_456]);
    // primera vez: plano
    renderMonto();
    const montoEl = document.getElementById("montoTotal");
    if (!montoEl) {
      throw new Error("sin #montoTotal");
    }
    expect(montoEl.getAttribute("aria-label")).toBe("US$ 1,234.56");
    const colasPlano = cols();
    expect(colasPlano.map((c) => c.dataset["muestra"])).toStrictEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    // regresión del "8": la ventana cae sobre la célula del dígito, no de la base
    expect(tiraDe(colasPlano[0] as HTMLElement).style.transform).toBe("translateY(-48px)");
    // las estáticas del plano no portan filtro de blur
    for (const c of colasPlano) {
      expect(tiraDe(c).style.filter).toBe("");
    }
  });

  it("aumento: lo que cambia rueda hacia arriba, incluidas las posiciones nuevas", () => {
    state.moneda = "USD";
    hojaCon([99_999]);
    // plano doble: mata todo rAF pendiente y fija el texto previo (determinismo)
    state.moneda = "BOB";
    renderMonto();
    state.moneda = "USD";
    renderMonto();
    state.hojas.pop();
    // US$ 1,000.99 → crece una cifra
    hojaCon([100_099]);
    renderMonto();
    // sufN "1,000.99" alineado con "  999.99": 1 nace y sube (fin 11 > 0),
    // los 9→0 suben (fin 20 > 9); los 9 finales quedan fijos. El bug del
    // pop-que-bajaba muere aquí: ninguna posición nueva desciende.
    const colasAlto = cols();
    expect(colasAlto.map((c) => c.dataset["muestra"])).toStrictEqual([
      "11",
      "20",
      "20",
      "20",
      "9",
      "9",
    ]);
    // la ventana nunca sale de la tira (regresión del "desaparecen")
    for (const c of colasAlto) {
      const celulas = [...c.querySelectorAll<HTMLElement>(".monto-digito")];
      const ultima = celulas.at(-1);
      if (!ultima) {
        throw new Error("sin células");
      }
      expect(Number(c.dataset["muestra"])).toBeLessThanOrEqual(Number(ultima.dataset["i"]));
    }
    // solo giratorias portan filtro (las estáticas sin blur fantasma; jsdom cita la url)
    expect(tiraDe(colasAlto[0] as HTMLElement).style.filter).toContain("monto-blur-");
    expect(tiraDe(colasAlto[4] as HTMLElement).style.filter).toBe("");
  });

  it("disminución: la rueda baja (fin negativo = descendió por el ciclo)", () => {
    state.moneda = "USD";
    hojaCon([35_000]);
    // plano doble: mata todo rAF pendiente y fija el texto previo (determinismo)
    state.moneda = "BOB";
    renderMonto();
    state.moneda = "USD";
    renderMonto();
    state.hojas.pop();
    // US$ 100.00
    hojaCon([10_000]);
    renderMonto();
    // sufV= sufN "350.00"→"100.00": 3→1 baja -12 (fin -9), 5→0 baja -15 (fin -10)
    expect(cols().map((c) => c.dataset["muestra"])).toStrictEqual(["-9", "-10", "0", "0", "0"]);
  });

  it("dígito sin cambio queda fijo: transition none y clavado en su dígito", () => {
    state.moneda = "USD";
    hojaCon([35_000]);
    // plano doble: mata todo rAF pendiente y fija el texto previo (determinismo)
    state.moneda = "BOB";
    renderMonto();
    state.moneda = "USD";
    renderMonto();
    state.hojas.pop();
    // US$ 351.00: solo el 0→1 del sufijo rueda
    hojaCon([35_100]);
    renderMonto();
    const colas = cols();
    expect(colas.map((c) => c.dataset["muestra"])).toStrictEqual(["11", "0", "0"]);
    expect(tiraDe(colas[1] as HTMLElement).style.transition).toBe("none");
    expect(tiraDe(colas[2] as HTMLElement).style.transition).toBe("none");
  });

  it("cambio de moneda reescribe plano, sin rueda", () => {
    state.moneda = "USD";
    hojaCon([35_100]);
    // sincroniza
    renderMonto();
    // mismos cents, otro texto
    state.moneda = "ARS";
    renderMonto();
    expect(cols().map((c) => c.dataset["muestra"])).toStrictEqual(["3", "5", "1", "0", "0"]);
    for (const c of cols()) {
      expect(tiraDe(c).style.transition).toBe("none");
    }
  });

  it("llamada duplicada no toca el DOM", () => {
    state.moneda = "USD";
    hojaCon([123_456]);
    renderMonto();
    const antes = document.getElementById("montoTotal")?.innerHTML ?? "";
    renderMonto();
    expect(document.getElementById("montoTotal")?.innerHTML).toBe(antes);
  });

  it("vuelo a mitad (retarget): la dirección sigue la del delta total", () => {
    state.moneda = "USD";
    hojaCon([99_999]);
    // agenda rAF ⇒ el siguiente render corre EN VUELO
    renderMonto();
    state.hojas.pop();
    // sube: US$ 1,000.99
    hojaCon([100_099]);
    renderMonto();
    // aterriza en el dígito correcto (sea barrido limpio o continuación)
    const normal = (nn: number): number => ((nn % 10) + 10) % 10;
    const esperados = [1, 0, 0, 0, 9, 9];
    for (const [i, c] of cols().entries()) {
      expect(normal(Number(c.dataset["muestra"] ?? ""))).toBe(esperados[i] as number);
    }
    // y toda rueda avanza hacia arriba, nunca hacia abajo (delta +)
    const saltos = cols().map((c) => Number(c.dataset["muestra"]) - Number(c.dataset["arranque"]));
    // al menos una rueda se movió
    expect(saltos.some((salto) => salto !== 0)).toBe(true);
    for (const salto of saltos.filter((s) => s !== 0)) {
      expect(salto).toBeGreaterThan(0);
    }
  });

  it("vuelo a mitad condelta invertido: el cambio de sentido también respeta el delta", () => {
    state.moneda = "USD";
    // dejamos una rueda agendada del vuelo previo
    hojaCon([100_099]);
    renderMonto();
    state.hojas.pop();
    // baja: US$ 350.00
    hojaCon([35_000]);
    renderMonto();
    const normal = (nn: number): number => ((nn % 10) + 10) % 10;
    const esperados = [3, 5, 0, 0, 0];
    for (const [i, c] of cols().entries()) {
      expect(normal(Number(c.dataset["muestra"] ?? ""))).toBe(esperados[i] as number);
    }
    const saltos = cols().map((c) => Number(c.dataset["muestra"]) - Number(c.dataset["arranque"]));
    // al menos una rueda se movió
    expect(saltos.some((salto) => salto !== 0)).toBe(true);
    for (const salto of saltos.filter((s) => s !== 0)) {
      expect(salto).toBeLessThan(0);
    }
  });
});

describe("barraBoton", () => {
  function botonCalcular(): HTMLButtonElement {
    const b = document.getElementById("btnCalcular");
    if (!(b instanceof HTMLButtonElement)) {
      throw new TypeError("sin #btnCalcular");
    }
    return b;
  }

  it("siempre visible: 0/0, mitad y lleno", () => {
    state.moneda = "USD";
    const btn = botonCalcular();
    // sin hojas
    renderMonto();
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

  it("fantasma: actualiza los dos .calculo-txt de prod", () => {
    state.moneda = "USD";
    const btn = botonCalcular();
    btn.innerHTML =
      '<span class="calculo-txt"></span><span class="calculo-cuenta"></span><span class="calculo-capa" aria-hidden="true"><span class="calculo-txt" aria-hidden="true"></span><span class="calculo-cuenta" aria-hidden="true"></span></span>';
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    h.slots[1] = comprobante({ estado: "ok", textoOcr: "TOTAL 7" });
    state.hojas.push(h);
    renderMonto();
    expect([...btn.querySelectorAll(".calculo-txt")].map((s) => s.textContent)).toStrictEqual([
      "Montos extraídos: ",
      "Montos extraídos: ",
    ]);
    expect([...btn.querySelectorAll(".calculo-cuenta")].map((s) => s.textContent)).toStrictEqual([
      "1/2",
      "1/2",
    ]);
    btn.innerHTML = "";
  });

  it("añadir sin monto encoge la barra sin tocar el total", () => {
    state.moneda = "USD";
    const btn = botonCalcular();
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 500 });
    state.hojas.push(h);
    renderMonto();
    expect(btn.textContent).toBe("Montos extraídos: 1/1");
    h.slots[1] = comprobante({ estado: "ok", textoOcr: "TOTAL 7" });
    // mismo total: el odómetro no se toca…
    renderMonto();
    expect(document.getElementById("montoTotal")?.getAttribute("aria-label")).toBe("US$ 5.00");
    // …pero la barra sí se mueve
    expect(btn.textContent).toBe("Montos extraídos: 1/2");
    expect(btn.style.getPropertyValue("--progreso")).toBe("0.5");
  });

  it("btnLimpiar deshabilitado con lote vacío, habilitado con items", () => {
    const limpiar = document.getElementById("btnLimpiar");
    if (!(limpiar instanceof HTMLButtonElement)) {
      throw new TypeError("sin #btnLimpiar");
    }
    // sin hojas
    renderMonto();
    expect(limpiar.disabled).toBe(true);
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5" });
    state.hojas.push(h);
    renderMonto();
    expect(limpiar.disabled).toBe(false);
  });

  it("lote vacío: TODOS los botones de acción de la sidebar deshabilitados", () => {
    const botones = ["btnCalcular", "btnWord", "btnPdf", "btnImprimir", "btnLimpiar"].map((id) => {
      const b = document.getElementById(id);
      if (!(b instanceof HTMLButtonElement)) {
        throw new TypeError(`sin #${id}`);
      }
      return b;
    });
    // sin hojas
    renderMonto();
    for (const b of botones) {
      expect(b.disabled).toBe(true);
    }
    const h = crearHoja("u6x2");
    h.slots[0] = comprobante({ estado: "ok", textoOcr: "TOTAL 5" });
    state.hojas.push(h);
    renderMonto();
    for (const b of botones) {
      expect(b.disabled).toBe(false);
    }
  });
});

describe("parsearMonto", () => {
  it("US: miles con coma, decimal con punto, plano", () => {
    expect(parsearMonto("1,234.56")).toBe(123_456);
    expect(parsearMonto("1234.56")).toBe(123_456);
    expect(parsearMonto("1,234,567.89")).toBe(123_456_789);
    expect(parsearMonto("500")).toBe(50_000);
    expect(parsearMonto("12.5")).toBe(1250);
    expect(parsearMonto("  $ 1,234.56 ")).toBe(123_456);
  });

  it("inválidos → null", () => {
    expect(parsearMonto("")).toBeNull();
    expect(parsearMonto("abc")).toBeNull();
    // coma decimal EU: solo vale punto
    expect(parsearMonto("1234,56")).toBeNull();
    // miles sin decimales: escribir 1234
    expect(parsearMonto("1,234")).toBeNull();
    expect(parsearMonto("12.345")).toBeNull();
    expect(parsearMonto("-5")).toBeNull();
    // grupo vacío
    expect(parsearMonto("1,,234.56")).toBeNull();
    // mismo separador en miles y decimal
    expect(parsearMonto("1.234.56")).toBeNull();
    // grupo de 2
    expect(parsearMonto("1,234,56")).toBeNull();
    // grupo de 1
    expect(parsearMonto("1.2.3")).toBeNull();
    // grupo de 2
    expect(parsearMonto("12,34.56")).toBeNull();
  });
});

describe("odómetro helpers", () => {
  it("prefijoComun: largo del tramo idéntico", () => {
    expect(prefijoComun("US$ 100.00", "US$ 350.00")).toBe(4);
    expect(prefijoComun("", "x")).toBe(0);
    expect(prefijoComun("abc", "abcdef")).toBe(3);
  });

  it("alinearSufijos: recorte por la derecha o pad a la izquierda", () => {
    expect(alinearSufijos("999.99", "1,000.99")).toBe("  999.99");
    expect(alinearSufijos("1,000.99", "999.99")).toBe("000.99");
    expect(alinearSufijos("5", "5")).toBe("5");
  });

  it("spanFijo: span sin clase con el carácter", () => {
    const f = spanFijo("$");
    expect(f.tagName).toBe("SPAN");
    expect(f.className).toBe("");
    expect(f.textContent).toBe("$");
  });
});
