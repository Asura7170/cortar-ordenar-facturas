/* Tests modelos LLM: normalización chat/responses y listado /models. */
import { describe, expect, it, vi } from "vite-plus/test";
import { detectarTipo, extraerIdsModelos, listarModelos, urlListaModelos } from "./modelos";

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
});
