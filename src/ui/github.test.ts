/* Tests: botón GitHub — conteo vivo y fallback offline (DOM aislado). */
import { describe, expect, it } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

montarFixture();
const { initGithub } = await import("./github");

const estrellas = el("githubStars");

function respuestaEstrellas(n: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: (): Promise<unknown> => Promise.resolve({ stargazers_count: n }),
  } as Response;
}

describe("initGithub", () => {
  it("pinta el conteo de estrellas", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => respuestaEstrellas(42)) as typeof fetch;
    try {
      await initGithub();
    } finally {
      globalThis.fetch = real;
    }
    expect(estrellas.textContent).toBe("42");
  });

  it("sin red deja el botón estático sin lanzar", async () => {
    estrellas.textContent = "";
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error("offline");
    }) as typeof fetch;
    try {
      await initGithub();
    } finally {
      globalThis.fetch = real;
    }
    expect(estrellas.textContent).toBe("");
  });
});
