/* Tests JEV: pipeline del prototipo + cliente /api/jev + JEV-primero sin romper fallback. */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

vi.mock("../ui/sheets", () => ({ renderHojas: vi.fn() }));

montarFixture();
const { crearHoja, state } = await import("../state");
const { comprobante } = await import("../test/factoria");
const { renderHojas } = await import("../ui/sheets");
const {
  MONTO_RE,
  buildRequest,
  clearJevKey,
  extractCandidates,
  extractTotalOffline,
  extractTotalOfflineCents,
  formatMonto,
  getJevKey,
  llamarJev,
  resolveTotal,
  setJevKey,
} = await import("./jev");
const { aplicarTotales, extraerPendientes, extraerUnMonto } = await import("./extract");
import type { FetchFn } from "./jev";
import type { ItemLote } from "./extract";

const aviso = el("aviso");

/** Responde como el upstream: elige el primer candidato del body (conf 0.95). */
function upstreamOk(body: unknown, modelo = "jev-1.13.0"): Response {
  const candidatos =
    (body as { state?: { candidatos?: { id?: unknown }[] } })?.state?.candidatos ?? [];
  const primero = candidatos[0]?.id;
  return {
    ok: true,
    status: 200,
    headers: { get: (): null => null },
    json: (): Promise<unknown> =>
      Promise.resolve(
        typeof primero === "string"
          ? { answers: { total: { choice: primero, confidence: 0.95 } }, model: modelo }
          : { answers: { total: { choice: "none" } }, model: modelo },
      ),
  } as unknown as Response;
}

beforeEach(() => {
  state.hojas = [];
  state.colaEnProceso = false;
  state.configIA = { baseUrl: "https://llm.test/v1", model: "m", apiKey: "k" };
  aviso.textContent = "";
  clearJevKey();
  try {
    sessionStorage.clear();
  } catch {
    /* sin sessionStorage */
  }
  vi.mocked(renderHojas).mockClear();
});

describe("pipeline prototipo", () => {
  it("filtra cuentas sin decimal e ignora precios x4 decimales", () => {
    expect(extractCandidates("Bs 18,490.34 Cuenta 40005189200").map((c) => c.valor)).toEqual([
      "18,490.34",
    ]);
    expect(extractCandidates("x Bs 8.2500 = Bs 1,650.00").map((c) => c.valor)).toEqual([
      "1,650.00",
    ]);
  });

  it("formato X,XXX.XX", () => {
    expect(formatMonto("4,252.01")).toBe("4,252.01");
    expect(MONTO_RE.test("4,252.01")).toBe(true);
    expect(MONTO_RE.test("12.50")).toBe(true);
    expect(MONTO_RE.test("abc")).toBe(false);
  });

  it("offline elige TOTAL A COBRAR sobre Sub-Total/ICE (oracle id 8)", () => {
    const contenido =
      "Sub-Total: 4,702.80 Descuento: 0.00 ICE: 450.79 Total: 4,702.80 TOTAL A COBRAR: 4,252.01";
    expect(extractTotalOffline({ id: 8, contenido })).toBe("4,252.01");
    expect(extractTotalOfflineCents({ id: 8, contenido })).toBe(425201);
  });

  it("buildRequest: type minúsculas, ≤40, state con contenido+candidatos", () => {
    const req = buildRequest({ id: 1, contenido: "TOTAL 12.50" });
    expect(req.questions.total.type).toBe("choice");
    expect(req.meta.pool.length).toBeLessThanOrEqual(40);
    expect(req.state.contenido).toContain("TOTAL");
  });

  it("buildRequest recorta a 40 con Tier1", () => {
    const contenido = Array.from({ length: 60 }, (_, i) => `TOTAL ${100 + i}.00`).join(" ");
    expect(buildRequest({ id: 1, contenido }).meta.pool.length).toBeLessThanOrEqual(40);
  });

  it("resolveTotal: choice válido, sin confianza baja ni none", () => {
    const req = buildRequest({ id: 8, contenido: "TOTAL A COBRAR: 4,252.01" });
    const id = req.meta.pool[0]?.id ?? "c0";
    expect(resolveTotal(req, { choice: id, confidence: 0.9 })).toBe("4,252.01");
    expect(resolveTotal(req, { choice: id, confidence: 0.2 })).toBe("4,252.01"); // fallback al mismo pool
    expect(resolveTotal(req, { choice: "none" })).toBe("4,252.01");
  });
});

describe("key JEV", () => {
  it("vive en sessionStorage, nunca en localStorage", () => {
    setJevKey("apik-prueba");
    expect(getJevKey()).toBe("apik-prueba");
    expect(sessionStorage.getItem("jev-api-key")).toBe("apik-prueba");
    const raw = localStorage.getItem("libro-mayor-state") ?? "";
    expect(raw).not.toContain("apik-prueba");
    clearJevKey();
    expect(getJevKey()).toBe("");
  });
});

describe("llamarJev", () => {
  it("éxito valida formato y devuelve fuente jev:*", async () => {
    let url = "";
    let auth = "";
    let cuerpo = "";
    const fetchFn = vi.fn(async (u: unknown, o?: RequestInit): Promise<Response> => {
      url = String(u);
      auth = String((o?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "");
      cuerpo = String(o?.body ?? "");
      return upstreamOk(o?.body, "jev-1.13.0");
    });
    const r = await llamarJev(
      { id: 8, contenido: "TOTAL A COBRAR: 4,252.01" },
      "apik-k",
      fetchFn as FetchFn,
    );
    expect(r).toEqual({ total: "4,252.01", source: "jev:jev-1.13.0" });
    expect(url).toBe("/api/jev");
    expect(auth).toBe("Bearer apik-k");
    expect(cuerpo).toContain('"model":"jev-latest"');
    expect(cuerpo).toContain('"type":"choice"');
  });

  it("respuesta con formato inválido lanza (no se pinta basura)", async () => {
    const fetchFn = vi.fn(async (u: unknown, o?: RequestInit): Promise<Response> =>
      upstreamOk(o?.body),
    );
    await expect(
      llamarJev({ id: 1, contenido: "sin montos aquí" }, "k", fetchFn as FetchFn),
    ).rejects.toThrow("respuesta inválida");
  });

  it("sin key lanza sin fetch", async () => {
    const fetchFn = vi.fn();
    await expect(llamarJev({ id: 1, contenido: "x" }, "  ", fetchFn as FetchFn)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("429 reintenta una vez honrando retry-after", async () => {
    let n = 0;
    const fetchFn = vi.fn(async (u: unknown, o?: RequestInit): Promise<Response> => {
      n++;
      if (n === 1)
        return {
          ok: false,
          status: 429,
          headers: { get: (k: string): string | null => (k === "retry-after" ? "0" : null) },
          json: (): Promise<unknown> => Promise.resolve({}),
        } as unknown as Response;
      return upstreamOk(o?.body);
    });
    const r = await llamarJev({ id: 1, contenido: "TOTAL 12.50" }, "k", fetchFn as FetchFn);
    expect(r.total).toBe("12.50");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("extraerPendientes con JEV", () => {
  it("JEV-primero aplica en paralelo y no llama al OpenAI si todo resuelve", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    const c2 = comprobante({ estado: "ok", textoOcr: "TOTAL 7.00" });
    h.slots[0] = c1;
    h.slots[1] = c2;
    state.hojas.push(h);
    setJevKey("apik-k");
    const llamadas: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> => {
      llamadas.push(String(u));
      if (String(u) === "/api/jev") return upstreamOk(o?.body);
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> =>
          Promise.resolve({ choices: [{ message: { content: '{"99":"1.00"}' } }] }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBe(1250);
    expect(c2.montoCents).toBe(700);
    expect(llamadas).not.toContain("https://llm.test/v1");
    expect(aviso.textContent).toContain("JEV:");
  });

  it("JEV caído → fallback OpenAI intacto", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown): Promise<Response> => {
      if (String(u) === "/api/jev")
        return {
          ok: false,
          status: 500,
          headers: { get: (): null => null },
        } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> =>
          Promise.resolve({ choices: [{ message: { content: '{"1":"12.50"}' } }] }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBe(1250);
  });

  it("sin key JEV el flujo OpenAI anterior sigue igual", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        json: (): Promise<unknown> =>
          Promise.resolve({ choices: [{ message: { content: '{"1":"12.50"}' } }] }),
      }) as unknown as Response) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBe(1250);
    expect(aviso.textContent).toContain("IA:");
  });

  it("aplicarTotales respeta manual también en vía JEV", () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 5", montoCents: 9999 });
    h.slots[0] = c1;
    state.hojas.push(h);
    const items: ItemLote[] = [{ idx: 1, id: c1.id, texto: "TOTAL 5" }];
    expect(aplicarTotales(items, new Map([[1, 4200]]))).toBe(0);
    expect(c1.montoCents).toBe(9999);
  });

  it("JEV en paralelo resuelve todo con 1 render coalescado (orden de llegada libre)", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    const c2 = comprobante({ estado: "ok", textoOcr: "TOTAL 7.00" });
    h.slots[0] = c1;
    h.slots[1] = c2;
    state.hojas.push(h);
    setJevKey("apik-k");
    const vistos: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> => {
      if (String(u) === "/api/jev") {
        const cuerpo = JSON.parse(String(o?.body ?? "{}")) as {
          state?: { contenido?: unknown };
        };
        vistos.push(String(cuerpo.state?.contenido ?? ""));
        return upstreamOk(o?.body);
      }
      throw new Error("no debe llamar al OpenAI si JEV resuelve todo");
    }) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(vistos.sort()).toEqual(["TOTAL 12.50", "TOTAL 7.00"].sort());
    expect(c1.montoCents).toBe(1250);
    expect(c2.montoCents).toBe(700);
    expect(vi.mocked(renderHojas).mock.calls.length).toBe(1);
  });

  it("pool con tope 50: 60 ítems resuelven todos sin superar el tope", async () => {
    for (let n = 0; n < 60; n++) {
      const h = crearHoja();
      h.slots[0] = comprobante({ estado: "ok", textoOcr: `TOTAL ${n + 1}.00` });
      state.hojas.push(h);
    }
    setJevKey("apik-k");
    let activos = 0;
    let maximo = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> => {
      if (String(u) !== "/api/jev") throw new Error("no debe llamar al OpenAI");
      activos++;
      maximo = Math.max(maximo, activos);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return upstreamOk(o?.body);
      } finally {
        activos--;
      }
    }) as typeof fetch;
    try {
      await extraerPendientes();
    } finally {
      globalThis.fetch = real;
    }
    expect(maximo).toBeGreaterThan(1); // realmente en paralelo
    expect(maximo).toBeLessThanOrEqual(50);
    const sinMonto = state.hojas
      .flatMap((hh) => hh.slots)
      .filter((c) => c && c.montoCents === null);
    expect(sinMonto.length).toBe(0);
    expect(aviso.textContent).toContain("JEV: 60/60");
  });

  it("progresivo: los rápidos se pintan sin esperar al lento", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    const c2 = comprobante({ estado: "ok", textoOcr: "TOTAL 7.00" });
    h.slots[0] = c1;
    h.slots[1] = c2;
    state.hojas.push(h);
    setJevKey("apik-k");
    let cuerpoLento = "";
    let resolverLento: (r: Response) => void = () => {};
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> => {
      if (String(u) !== "/api/jev") throw new Error("no debe llamar al OpenAI");
      const cuerpo = String(o?.body ?? "");
      if (cuerpo.includes("7.00")) {
        cuerpoLento = cuerpo;
        return new Promise<Response>((res) => {
          resolverLento = res;
        });
      }
      return upstreamOk(cuerpo);
    }) as typeof fetch;
    const p = extraerPendientes();
    try {
      await new Promise((r) => setTimeout(r, 20));
      // El rápido ya está aplicado y parchado aunque el lento siga en vuelo
      // (parche in-place: 0 rebuilds a mitad del lote).
      expect(c1.montoCents).toBe(1250);
      expect(c2.montoCents).toBeNull();
      expect(vi.mocked(renderHojas).mock.calls.length).toBe(0);
      expect(aviso.textContent).toContain("1/2");
      resolverLento(upstreamOk(cuerpoLento));
      await p;
    } finally {
      globalThis.fetch = real;
    }
    expect(c2.montoCents).toBe(700);
    expect(vi.mocked(renderHojas).mock.calls.length).toBe(1);
  });
});

describe("extraerUnMonto (1×1 de la cola)", () => {
  it("aplica y pinta al instante", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> =>
      upstreamOk(o?.body)) as typeof fetch;
    try {
      expect(await extraerUnMonto(c1.id)).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBe(1250);
    expect(vi.mocked(renderHojas)).toHaveBeenCalledTimes(1);
  });

  it("sin key no hace fetch y devuelve false", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    const real = globalThis.fetch;
    const espia = vi.fn(real);
    globalThis.fetch = espia;
    try {
      expect(await extraerUnMonto(c1.id)).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
    expect(espia).not.toHaveBeenCalled();
    expect(c1.montoCents).toBeNull();
  });

  it("JEV caído devuelve false sin romper (la red del drenado lo intenta)", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      ({
        ok: false,
        status: 500,
        headers: { get: (): null => null },
      }) as unknown as Response) as typeof fetch;
    try {
      expect(await extraerUnMonto(c1.id)).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
    expect(c1.montoCents).toBeNull();
  });

  it("manual o monto ya fijado no hace fetch", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50", montoManual: true });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    const fetchFn = vi.fn();
    expect(await extraerUnMonto(c1.id, fetchFn as FetchFn)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("comprobante eliminado no resucita ni lanza", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    state.hojas = [crearHoja()];
    const fetchFn = vi.fn();
    expect(await extraerUnMonto(c1.id, fetchFn as FetchFn)).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("segundo llamado en vuelo no duplica fetch", async () => {
    const h = crearHoja();
    const c1 = comprobante({ estado: "ok", textoOcr: "TOTAL 12.50" });
    h.slots[0] = c1;
    state.hojas.push(h);
    setJevKey("apik-k");
    let cuerpo = "";
    let resolver: (r: Response) => void = () => {};
    const fetchFn = vi.fn(
      (u: unknown, o?: RequestInit): Promise<Response> =>
        new Promise<Response>((res) => {
          cuerpo = String(o?.body ?? "");
          resolver = res;
        }),
    );
    const p1 = extraerUnMonto(c1.id, fetchFn as FetchFn);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await extraerUnMonto(c1.id, fetchFn as FetchFn)).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    resolver(upstreamOk(cuerpo));
    expect(await p1).toBe(true);
    expect(c1.montoCents).toBe(1250);
  });
});
