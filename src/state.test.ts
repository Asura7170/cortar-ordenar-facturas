/* Tests P0: estado, persistencia y operaciones puras (sin DOM). */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  LS_KEY,
  borrarCodigo,
  buscarSlot,
  cargar,
  crearHoja,
  guardarAjustes,
  guardarCodigo,
  hojaPorId,
  isMoneda,
  isPosicionCodigo,
  limpiarHojas,
  nextComprobanteId,
  nextHojaId,
  redistribuir,
  restablecerAjustes,
  state,
} from "./state";
import type { LayoutId } from "./types";
import { comprobante } from "./test/factoria";

describe("ids monótonos", () => {
  it("nextComprobanteId y nextHojaId crecen de a 1", () => {
    expect(nextComprobanteId() + 1).toBe(nextComprobanteId());
    expect(nextHojaId() + 1).toBe(nextHojaId());
  });
});

describe("crearHoja", () => {
  it("por defecto es u4x2 con 4 slots vacíos", () => {
    const h = crearHoja();
    expect(h.layout).toBe("u4x2");
    expect(h.slots).toEqual([null, null, null, null]);
    expect(h.id).toEqual(expect.any(Number));
  });

  it("respeta la capacidad de la plantilla pedida", () => {
    expect(crearHoja("u1").slots).toHaveLength(1);
    expect(crearHoja("u6x2").slots).toHaveLength(6);
  });

  it("layout desconocido: cae a capacidad u4x2 pero conserva el id pedido", () => {
    const h = crearHoja("bogus" as unknown as LayoutId);
    expect(h.slots).toHaveLength(4);
    expect(h.layout).toBe("bogus");
  });
});

describe("guardar/cargar por ventana", () => {
  it("round-trip: cada ventana persiste lo suyo y lo restaura", () => {
    state.codigoActivo = true;
    state.codigoValor = "12345678";
    state.codigoPosicion = "sup-izq";
    guardarCodigo();
    state.moneda = "BOB";
    guardarAjustes();

    state.codigoActivo = false;
    state.codigoValor = "";
    state.codigoPosicion = "inf-der";
    state.moneda = "USD";
    cargar();

    expect(state.codigoActivo).toBe(true);
    expect(state.codigoValor).toBe("12345678");
    expect(state.codigoPosicion).toBe("sup-izq");
    expect(state.moneda).toBe("BOB");
  });

  it("cada guardado preserva la otra ventana (merge, no reemplazo)", () => {
    state.moneda = "ARS";
    guardarAjustes();
    state.codigoActivo = true;
    state.codigoValor = "87654321";
    guardarCodigo();

    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, unknown>;
    expect(raw["moneda"]).toBe("ARS");
    expect(raw["codigoValor"]).toBe("87654321");
  });

  it("solo persiste el subset PersistedState (hojas y modoOcr quedan fuera)", () => {
    const h = crearHoja();
    h.slots[0] = comprobante();
    state.hojas.push(h);
    state.modoOcr = true;
    guardarCodigo();
    guardarAjustes();

    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      "codigoActivo",
      "codigoPosicion",
      "codigoValor",
      "moneda",
    ]);
  });

  it("borrarCodigo retira lo suyo, conserva ajustes y vacía la clave si queda sola", () => {
    state.moneda = "EUR";
    guardarAjustes();
    state.codigoValor = "123";
    guardarCodigo();
    borrarCodigo();
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, unknown>;
    expect(raw["moneda"]).toBe("EUR");
    expect("codigoValor" in raw).toBe(false);

    localStorage.clear();
    state.codigoValor = "123";
    guardarCodigo();
    borrarCodigo();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });

  it("cargar sin código: defaults false/6/″″ y conserva ajustes", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ moneda: "ARS" }));
    cargar();
    expect(state.codigoActivo).toBe(false);
    expect(state.codigoValor).toBe("");
    expect(state.moneda).toBe("ARS");
  });

  it("blob legacy solo-código (sin moneda ni posición): restaura el código y usa defaults", () => {
    state.moneda = "EUR";
    localStorage.setItem(LS_KEY, JSON.stringify({ codigoActivo: true, codigoValor: "12345678" }));
    cargar();
    expect(state.codigoActivo).toBe(true);
    expect(state.codigoValor).toBe("12345678");
    expect(state.codigoPosicion).toBe("inf-der");
    expect(state.moneda).toBe("EUR");
  });

  it("posición inválida: cae a inferior derecha", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ codigoPosicion: "centro" }));
    cargar();
    expect(state.codigoPosicion).toBe("inf-der");
  });

  it("JSON corrupto: no tira y conserva el estado", () => {
    state.moneda = "ARS";
    localStorage.setItem(LS_KEY, "no-json{");
    expect(() => cargar()).not.toThrow();
    expect(state.moneda).toBe("ARS");
  });

  it("forma inválida (moneda desconocida): se ignora", () => {
    state.moneda = "EUR";
    localStorage.setItem(LS_KEY, JSON.stringify({ moneda: "XXX" }));
    cargar();
    expect(state.moneda).toBe("EUR");
  });

  it("sobrante de la era IA: configIA se retira del blob y las claves se borran", () => {
    localStorage.setItem("jev-api-key", "apik-vieja");
    sessionStorage.setItem("jev-api-key", "apik-sesion");
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        codigoActivo: false,
        codigoValor: "",
        moneda: "USD",
        configIA: { baseUrl: "http://solo" },
      }),
    );
    cargar();
    expect(state.moneda).toBe("USD");
    expect(localStorage.getItem("jev-api-key")).toBeNull();
    expect(sessionStorage.getItem("jev-api-key")).toBeNull();
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? "{}")).toEqual({
      codigoActivo: false,
      codigoValor: "",
      moneda: "USD",
    });
  });

  it("blob no-objeto: no lanza y deja el storage intacto", () => {
    for (const raw of ['"null"', "5", "[]"]) {
      localStorage.setItem(LS_KEY, raw);
      expect(() => cargar()).not.toThrow();
      expect(localStorage.getItem(LS_KEY)).toBe(raw);
    }
  });

  it("sessionStorage caído: la limpieza igual corre y el estado carga", () => {
    state.moneda = "ARS";
    localStorage.setItem(LS_KEY, JSON.stringify({ moneda: "ARS" }));
    const espiado = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {
      throw new Error("sin sesión");
    });
    try {
      expect(() => cargar()).not.toThrow();
      expect(state.moneda).toBe("ARS");
    } finally {
      espiado.mockRestore();
    }
  });

  it("blob solo de configIA: se retira y la clave queda eliminada", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ configIA: { baseUrl: "http://solo" } }));
    cargar();
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});

describe("isMoneda", () => {
  it.each(["USD", "ARS", "EUR", "BOB"] as const)("acepta %s", (m) => {
    expect(isMoneda(m)).toBe(true);
  });

  it.each(["XXX", "", null, undefined, 5])("rechaza %s", (v) => {
    expect(isMoneda(v)).toBe(false);
  });
});

describe("isPosicionCodigo", () => {
  it.each(["sup-izq", "sup-der", "inf-izq", "inf-der"] as const)("acepta %s", (p) => {
    expect(isPosicionCodigo(p)).toBe(true);
  });

  it.each(["centro", "", null, undefined, 5])("rechaza %s", (v) => {
    expect(isPosicionCodigo(v)).toBe(false);
  });
});

describe("restablecerAjustes", () => {
  it("vuelve a moneda default BOB, lo persiste y deja el código intacto", () => {
    state.codigoValor = "4242";
    guardarCodigo();
    state.moneda = "ARS";
    restablecerAjustes();
    expect(state.moneda).toBe("BOB");
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Record<string, unknown>;
    expect(raw["moneda"]).toBe("BOB");
    expect(raw["codigoValor"]).toBe("4242");
  });
});

describe("limpiarHojas", () => {
  it("elimina hojas vacías y conserva las ocupadas", () => {
    const vacia = crearHoja();
    const llena = crearHoja();
    llena.slots[1] = comprobante();
    state.hojas.push(vacia, llena);
    limpiarHojas();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]).toBe(llena);
  });

  it("nunca deja cero hojas: crea una u4x2", () => {
    limpiarHojas();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]?.layout).toBe("u4x2");
  });
});

describe("redistribuir", () => {
  it("recompacta sin huecos preservando el orden", () => {
    const h = crearHoja();
    const a = comprobante({ nombre: "a" });
    const b = comprobante({ nombre: "b" });
    h.slots = [a, null, b, null];
    state.hojas.push(h);
    redistribuir();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]?.slots).toEqual([a, b, null, null]);
  });

  it("recompacta en hojas existentes preservando su layout", () => {
    const h = crearHoja("u2h");
    const items = [1, 2, 3, 4, 5].map(() => comprobante());
    h.slots = [items[0] ?? null, items[1] ?? null];
    state.hojas.push(h);
    // 5 items en capacidad 2: entran 2 + 2 + 1
    const extra = crearHoja("u2h");
    extra.slots = [items[2] ?? null, null];
    state.hojas.push(extra);
    const tercera = crearHoja("u2h");
    tercera.slots = [items[3] ?? null, items[4] ?? null];
    state.hojas.push(tercera);
    redistribuir();
    expect(state.hojas).toHaveLength(3);
    expect(state.hojas.every((x) => x.layout === "u2h")).toBe(true);
    const ids = state.hojas.flatMap((x) => x.slots.map((c) => c?.id ?? null));
    expect(ids).toEqual([...items.map((c) => c.id), null]);
  });

  it("cambio de plantilla: el resto refluye a hojas nuevas con el default", () => {
    const h = crearHoja();
    const items = [1, 2, 3, 4].map(() => comprobante());
    h.slots = items;
    state.hojas.push(h);
    h.layout = "u1";
    redistribuir();
    expect(state.hojas).toHaveLength(2);
    expect(state.hojas[0]?.layout).toBe("u1");
    expect(state.hojas[1]?.layout).toBe("u4x2");
    // orden preservado: 1 en la u1, 3 en la nueva
    expect(state.hojas[0]?.slots).toEqual([items[0] ?? null]);
    expect(state.hojas[1]?.slots).toEqual([...items.slice(1), null]);
  });

  it("el resto no hereda el layout de la última hoja aunque sea no-default", () => {
    const a = crearHoja("u2h");
    const b = crearHoja("u2h");
    const items = [1, 2, 3, 4].map(() => comprobante());
    a.slots = [items[0] ?? null, items[1] ?? null];
    b.slots = [items[2] ?? null, items[3] ?? null];
    state.hojas.push(a, b);
    a.layout = "u1";
    redistribuir();
    // u1(1) + u2h(2) + la sobrante a una u4x2 (no u2h heredado)
    expect(state.hojas.map((x) => x.layout)).toEqual(["u1", "u2h", "u4x2"]);
    expect(state.hojas[2]?.slots).toEqual([items[3] ?? null, null, null, null]);
  });

  it("layoutNuevas pisa el default para 'aplicar a todas'", () => {
    const h = crearHoja("u4x2");
    const items = [1, 2, 3, 4].map(() => comprobante());
    h.slots = items;
    state.hojas.push(h);
    h.layout = "u1";
    redistribuir("u1");
    expect(state.hojas).toHaveLength(4);
    expect(state.hojas.every((x) => x.layout === "u1")).toBe(true);
  });

  it("descarta hojas que quedan vacías (recompacta en las primeras)", () => {
    state.hojas.push(crearHoja(), crearHoja());
    const c = comprobante();
    const llena = crearHoja();
    llena.slots[0] = c;
    state.hojas.push(llena);
    redistribuir();
    expect(state.hojas).toHaveLength(1);
    expect(state.hojas[0]?.slots[0]).toBe(c);
  });
});

describe("hojaPorId / buscarSlot", () => {
  it("hojaPorId acepta número y string", () => {
    const h = crearHoja();
    state.hojas.push(h);
    expect(hojaPorId(h.id)).toBe(h);
    expect(hojaPorId(String(h.id))).toBe(h);
    expect(hojaPorId(-1)).toBeUndefined();
  });

  it("buscarSlot encuentra hoja e índice, o null", () => {
    const h = crearHoja();
    const c = comprobante();
    h.slots[2] = c;
    state.hojas.push(h);
    expect(buscarSlot(c.id)).toEqual({ hoja: h, idx: 2 });
    expect(buscarSlot(-1)).toBeNull();
  });
});
