/* Tests P0: extract.ts — 1 llamada por lote, solo null, manual siempre gana. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));

montarFixture();
const { crearHoja, state } = await import("../state");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("../ui/sheets");
const {
  aplicarTotales,
  candidatos,
  construirPrompt,
  extraerJsonContenido,
  extraerPendientes,
  extraerTotalesLote,
  limpiarTexto,
  partirLote,
} = await import("./extract");
import type { ItemLote } from "./extract";
import type { FetchFn } from "./extract";

const aviso = el("aviso");

function respuesta(contenido: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: (): Promise<unknown> =>
      Promise.resolve({ choices: [{ message: { content: contenido } }] }),
  } as Response;
}

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
  state.configIA = { baseUrl: "https://llm.test/v1", model: "m", apiKey: "k" };
  aviso.textContent = "";
  vi.mocked(renderHojas).mockClear();
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
});

describe("extraerTotalesLote", () => {
  it("1 llamada aplica cents y respeta null", async () => {
    const { c1, c2 } = lote2();
    const fetchFn = vi.fn(async (): Promise<Response> => respuesta('{"1":"12.50","2":null}'));
    const items: ItemLote[] = [
      { idx: 1, id: c1.id, texto: "TOTAL 12.50" },
      { idx: 2, id: c2.id, texto: "TOTAL 7.00" },
    ];
    const n = aplicarTotales(items, await extraerTotalesLote(items, state.configIA, fetchFn));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(n).toBe(1);
    expect(c1.montoCents).toBe(1250);
    expect(c2.montoCents).toBeNull();
  });

  it("el prompt usa [#idx], nunca el nombre de archivo", async () => {
    const { c1 } = lote2();
    let cuerpo = "";
    const fetchFn = vi.fn(async (_u: unknown, o?: RequestInit): Promise<Response> => {
      cuerpo = String(o?.body ?? "");
      return respuesta('{"1":"1.00"}');
    });
    await extraerTotalesLote(
      [{ idx: 1, id: c1.id, texto: "TOTAL 1.00" }],
      state.configIA,
      fetchFn as FetchFn,
    );
    expect(cuerpo).toContain("[#1]");
    expect(cuerpo).not.toContain("factura (2).png");
  });

  it("fences ```json e inválidos → null (manual)", async () => {
    const { c1, c2 } = lote2();
    const fetchFn = vi.fn(async (): Promise<Response> =>
      respuesta('```json\n{"1":"abc","2":"7.00"}\n```'),
    );
    const items: ItemLote[] = [
      { idx: 1, id: c1.id, texto: "x" },
      { idx: 2, id: c2.id, texto: "y" },
    ];
    const mapa = await extraerTotalesLote(items, state.configIA, fetchFn);
    expect(mapa.get(1)).toBeNull();
    expect(mapa.get(2)).toBe(700);
  });

  it("HTTP error lanza (el orquestador lo deja manual)", async () => {
    const { c1 } = lote2();
    const fetchFn = vi.fn(async (): Promise<Response> => respuesta("x", false, 429));
    await expect(
      extraerTotalesLote([{ idx: 1, id: c1.id, texto: "x" }], state.configIA, fetchFn),
    ).rejects.toThrow("LLM 429");
  });
});

describe("aplicarTotales", () => {
  it("manual fijado durante el fetch gana (sigue en null al aplicar)", () => {
    const { c1 } = lote2();
    c1.montoCents = 9999; // el usuario escribió mientras volaba el fetch
    const n = aplicarTotales([{ idx: 1, id: c1.id, texto: "x" }], new Map([[1, 4200]]));
    expect(n).toBe(0);
    expect(c1.montoCents).toBe(9999);
  });

  it("comprobante quitado durante el fetch no resucita", () => {
    const h = crearHoja();
    const c = comprobante({ estado: "ok", textoOcr: "TOTAL 1" });
    h.slots[0] = c;
    state.hojas.push(h);
    state.hojas = [crearHoja()];
    const n = aplicarTotales([{ idx: 1, id: c.id, texto: "x" }], new Map([[1, 100]]));
    expect(n).toBe(0);
  });
});

describe("extraerPendientes", () => {
  it("auto: 1 fetch, pinta 1 vez y avisa el conteo", async () => {
    const { c1, c2 } = lote2();
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      respuesta('{"1":"12.50","2":"7.00"}')) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBe(1250);
    expect(c2.montoCents).toBe(700);
    expect(vi.mocked(renderHojas)).toHaveBeenCalledTimes(1);
    expect(aviso.textContent).toBe("IA: 2/2 totales.");
  });

  it("sin apiKey sale en silencio (auto) y avisa si es forzado", async () => {
    const { c1 } = lote2();
    state.configIA.apiKey = "  ";
    const real = globalThis.fetch;
    const espia = vi.fn(real);
    globalThis.fetch = espia;
    try {
      await extraerPendientes();
      expect(aviso.textContent).toBe("");
      await extraerPendientes({ forzado: true });
      expect(aviso.textContent).toContain("API key");
    } finally {
      globalThis.fetch = real;
    }
    expect(espia).not.toHaveBeenCalled();
    expect(c1.montoCents).toBeNull();
  });

  it("fallo de red → todo manual y aviso con conteo", async () => {
    const { c1 } = lote2();
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => respuesta("x", false, 500)) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBeNull();
    expect(aviso.textContent).toBe("IA: 0/2 totales, resto manual.");
  });

  it("auto bloqueado durante OCR salvo desdeCola (regresión)", async () => {
    const { c1 } = lote2();
    state.colaEnProceso = true;
    const real = globalThis.fetch;
    let llamadas = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      llamadas++;
      return respuesta('{"1":"12.50","2":"7.00"}');
    }) as typeof fetch;
    try {
      await extraerPendientes();
      expect(llamadas).toBe(0);
      expect(c1.montoCents).toBeNull();
      await extraerPendientes({ desdeCola: true });
      expect(llamadas).toBe(1);
      expect(c1.montoCents).toBe(1250);
    } finally {
      globalThis.fetch = real;
      state.colaEnProceso = false;
    }
  });
});

describe("utilidades", () => {
  it("limpiarTexto colapsa y capa a MAX_TEXTO", () => {
    expect(limpiarTexto("  TOTAL   12.50\n\nIVA 1 ")).toBe("TOTAL 12.50 IVA 1");
    expect(limpiarTexto("x".repeat(5000))).toHaveLength(1800);
  });

  it("partirLote corta por cantidad (25+5)", () => {
    const items: ItemLote[] = Array.from({ length: 30 }, (_, i) => ({
      idx: i + 1,
      id: i + 1,
      texto: "TOTAL 1.00",
    }));
    const lotes = partirLote(items);
    expect(lotes).toHaveLength(2);
    expect(lotes[0]).toHaveLength(25);
    expect(lotes[1]).toHaveLength(5);
  });

  it("extraerJsonContenido: directo, fence y ruido alrededor", () => {
    expect(extraerJsonContenido('{"1":"2.00"}')).toMatchObject({ "1": "2.00" });
    expect(extraerJsonContenido('```json\n{"1":null}\n```')).toMatchObject({ "1": null });
    expect(extraerJsonContenido('listo: {"1":"3.00"} fin')).toMatchObject({ "1": "3.00" });
    expect(extraerJsonContenido("sin json")).toBeNull();
  });

  it("construirPrompt numera bloques cortos", () => {
    expect(construirPrompt([{ idx: 1, texto: "TOTAL 1" }])).toContain("[#1]\nTOTAL 1");
  });
});
