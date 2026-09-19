/* Tests modelos LLM: normalización chat/responses y listado /models. */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  detectarTipo,
  esZen,
  extraerIdsModelos,
  listarModelos,
  probarConexion,
  sesionIA,
  sugeridosZenGo,
  urlListaModelos,
  urlProxy,
} from "./modelos";

describe("detectarTipo", () => {
  it("responses solo con sufijo explícito, resto chat", () => {
    expect(detectarTipo("https://api.openai.com/v1/responses")).toBe("responses");
    expect(detectarTipo("https://api.openai.com/v1/responses/")).toBe("responses");
    expect(detectarTipo("https://api.groq.com/openai/v1/chat/completions")).toBe("chat");
    expect(detectarTipo("https://api.groq.com/openai/v1")).toBe("chat");
  });
});

describe("urlListaModelos", () => {
  it("recorta chat/responses y añade /models", () => {
    expect(urlListaModelos("https://api.groq.com/openai/v1/chat/completions")).toBe(
      "https://api.groq.com/openai/v1/models",
    );
    expect(urlListaModelos("https://api.openai.com/v1/responses")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(urlListaModelos("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
    expect(urlListaModelos("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1/models");
  });
});

describe("extraerIdsModelos", () => {
  it("{data:[{id}]} y string[]; basura → []", () => {
    expect(extraerIdsModelos({ data: [{ id: "a" }, { id: "b" }, { id: "" }] })).toEqual(["a", "b"]);
    expect(extraerIdsModelos(["x", "x", 7])).toEqual(["x"]);
    expect(extraerIdsModelos({})).toEqual([]);
    expect(extraerIdsModelos(null)).toEqual([]);
  });
});

describe("listarModelos", () => {
  it("GET a /models con Bearer y devuelve ids", async () => {
    let url = "";
    let auth = "";
    const fetchFn = vi.fn(async (u: unknown, o?: RequestInit): Promise<Response> => {
      url = String(u);
      auth = String((o?.headers as Record<string, string>)?.["Authorization"] ?? "");
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [{ id: "m1" }] }),
      } as Response;
    });
    const lista = await listarModelos("https://x.test/v1/chat/completions", "k", fetchFn);
    expect(url).toBe("https://x.test/v1/models");
    expect(auth).toBe("Bearer k");
    expect(lista).toEqual(["m1"]);
  });

  it("HTTP error lanza", async () => {
    const fetchFn = vi.fn(async (): Promise<Response> => ({ ok: false, status: 401 }) as Response);
    await expect(listarModelos("https://x.test/v1", "k", fetchFn)).rejects.toThrow("Modelos 401");
  });

  it("TypeError (CORS/red) se tipa como CORS", async () => {
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    });
    await expect(listarModelos("https://x.test/v1", "k", fetchFn)).rejects.toThrow(/CORS/);
  });

  it("abort se tipa como timeout", async () => {
    const fetchFn = vi.fn(async (): Promise<Response> => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(listarModelos("https://x.test/v1", "k", fetchFn)).rejects.toThrow(/timeout/);
  });

  it("zen lista vía proxy dev", async () => {
    let url = "";
    const fetchFn = vi.fn(async (u: unknown): Promise<Response> => {
      url = String(u);
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [] }),
      } as Response;
    });
    await listarModelos("https://opencode.ai/zen/go/v1/chat/completions", "k", fetchFn);
    expect(url).toBe("/zen-go/v1/models");
  });
});

describe("sugeridosZenGo", () => {
  it("zen devuelve snapshot, resto vacío", () => {
    expect(sugeridosZenGo("https://opencode.ai/zen/go/v1/chat/completions")).toContain(
      "muse-spark-1.3-contributor",
    );
    expect(sugeridosZenGo("https://api.groq.com/openai/v1")).toEqual([]);
  });
});

describe("urlProxy", () => {
  it("zen va al proxy dev, resto directo", () => {
    expect(urlProxy("https://opencode.ai/zen/go/v1/responses")).toBe("/zen-go/v1/responses");
    expect(urlProxy("https://opencode.ai/zen/go/v1/chat/completions")).toBe(
      "/zen-go/v1/chat/completions",
    );
    expect(urlProxy("https://opencode.ai/zen/go/v1/models")).toBe("/zen-go/v1/models");
    expect(urlProxy("https://api.groq.com/openai/v1/chat/completions")).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
  });
});

describe("sesion zen", () => {
  it("estable entre llamadas y detecta zen", () => {
    expect(sesionIA()).toBe(sesionIA());
    expect(sesionIA().trim()).not.toBe("");
    expect(esZen("https://opencode.ai/zen/go/v1/responses")).toBe(true);
    expect(esZen("/zen-go/v1/models")).toBe(true);
    expect(esZen("https://api.groq.com/openai/v1")).toBe(false);
  });

  it("listar envía x-opencode-session solo en zen", async () => {
    let headers: Record<string, string> = {};
    const fetchFn = vi.fn(async (_u: unknown, o?: RequestInit): Promise<Response> => {
      headers = { ...((o?.headers ?? {}) as Record<string, string>) };
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [] }),
      } as Response;
    });
    await listarModelos("https://opencode.ai/zen/go/v1/chat/completions", "k", fetchFn);
    expect(headers["x-opencode-session"]).toBe(sesionIA());
    await listarModelos("https://api.groq.com/openai/v1/chat/completions", "k", fetchFn);
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("probarConexion", () => {
  it("chat ok con ping mínimo", async () => {
    let cuerpo = "";
    const fetchFn = vi.fn(async (_u: unknown, o?: RequestInit): Promise<Response> => {
      cuerpo = String(o?.body ?? "");
      return { ok: true, status: 200 } as Response;
    });
    const r = await probarConexion("https://x.test/v1/chat/completions", "k", "m", fetchFn);
    expect(r).toMatchObject({ ok: true, tipo: "chat" });
    expect(cuerpo).toContain("max_tokens");
    expect(cuerpo).not.toContain("max_output_tokens");
  });

  it("responses usa input y clasifica 401/CORS/timeout", async () => {
    let cuerpo = "";
    const okFn = vi.fn(async (_u: unknown, o?: RequestInit): Promise<Response> => {
      cuerpo = String(o?.body ?? "");
      return { ok: true, status: 200 } as Response;
    });
    const r = await probarConexion("https://x.test/v1/responses", "k", "m", okFn);
    expect(r).toMatchObject({ ok: true, tipo: "responses" });
    expect(cuerpo).toContain('"max_output_tokens":16');
    const malFn = vi.fn(async (): Promise<Response> => ({ ok: false, status: 401 }) as Response);
    expect(await probarConexion("https://x.test/v1", "k", "m", malFn)).toMatchObject({
      ok: false,
      mensaje: expect.stringContaining("401") as unknown,
    });
    const corsFn = vi.fn(async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    });
    expect(await probarConexion("https://x.test/v1", "k", "m", corsFn)).toMatchObject({
      ok: false,
      mensaje: expect.stringContaining("CORS") as unknown,
    });
    const abortFn = vi.fn(async (): Promise<Response> => {
      throw new DOMException("x", "AbortError");
    });
    expect(await probarConexion("https://x.test/v1", "k", "m", abortFn)).toMatchObject({
      ok: false,
      mensaje: expect.stringContaining("timeout") as unknown,
    });
  });

  it("400 propaga el mensaje del proveedor", async () => {
    const fn = vi.fn(async (): Promise<Response> => {
      return {
        ok: false,
        status: 400,
        json: (): Promise<unknown> =>
          Promise.resolve({
            type: "error",
            error: { type: "MissingSessionID", message: "falta sesion" },
          }),
      } as Response;
    });
    expect(await probarConexion("https://x.test/v1", "k", "m", fn)).toMatchObject({
      ok: false,
      mensaje: expect.stringContaining("falta sesion") as unknown,
    });
  });
});
