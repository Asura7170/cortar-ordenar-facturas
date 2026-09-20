/* Tests P1: modal de ajustes — submit y Predeterminado (DOM aislado). */
import { describe, expect, it, vi } from "vite-plus/test";
import { montarFixture, el } from "../test/fixture";

montarFixture();
const { state, crearHoja, guardarCodigo } = await import("../state");
const { initSettings } = await import("./settingsModal");
const { comprobante } = await import("../test/factoria");

const modalAjustes = el<HTMLDialogElement>("modalAjustes");
const btnAjustes = el<HTMLButtonElement>("btnAjustes");
const formAjustes = el<HTMLFormElement>("formAjustes");
const cfgBaseUrl = el<HTMLInputElement>("cfgBaseUrl");
const cfgModel = el<HTMLSelectElement>("cfgModel");
const cfgModelManual = el<HTMLInputElement>("cfgModelManual");
const cfgRazonamiento = el<HTMLSelectElement>("cfgRazonamiento");
const btnRefrescarModelos = el<HTMLButtonElement>("btnRefrescarModelos");
const estadoModelosIA = el("estadoModelosIA");
const cfgApiKey = el<HTMLInputElement>("cfgApiKey");
const btnProbarIA = el<HTMLButtonElement>("btnProbarIA");
const estadoPruebaIA = el("estadoPruebaIA");
const cfgMoneda = el<HTMLSelectElement>("cfgMoneda");
const btnResetAjustes = el<HTMLButtonElement>("btnResetAjustes");
const estadoModelos = el("estadoModelos");
const btnDescargarModelos = el<HTMLButtonElement>("btnDescargarModelos");
const btnBorrarModelos = el<HTMLButtonElement>("btnBorrarModelos");

initSettings();

function enviar(): void {
  formAjustes.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("abrir", () => {
  it("pinta los valores actuales y abre el modal", () => {
    state.configIA = { baseUrl: "http://a", model: "m", apiKey: "k" };
    state.moneda = "BOB";
    btnAjustes.click();
    expect(cfgBaseUrl.value).toBe("http://a");
    expect(cfgModel.value).toBe("m");
    expect(cfgApiKey.value).toBe("k");
    expect(cfgMoneda.value).toBe("BOB");
    expect(modalAjustes.hasAttribute("open")).toBe(true);
    modalAjustes.close();
  });
});

function opcion(v: string): void {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = v;
  cfgModel.append(o);
  cfgModel.value = v;
}

describe("submit", () => {
  it("persiste config+moneda, deja el código intacto y repinta el total", () => {
    const h = crearHoja();
    h.slots[0] = comprobante({ montoCents: 100 });
    state.hojas.push(h);
    state.codigoValor = "777";
    guardarCodigo();
    cfgBaseUrl.value = "http://nuevo";
    opcion("modelo-x");
    cfgApiKey.value = "secreto";
    cfgMoneda.value = "ARS";
    enviar();
    expect(state.configIA).toEqual({
      baseUrl: "http://nuevo",
      model: "modelo-x",
      apiKey: "secreto",
      razonamiento: "auto",
    });
    expect(state.moneda).toBe("ARS");
    expect(document.getElementById("montoTotal")?.textContent).toBe("AR$ 1.00");
    const raw = JSON.parse(localStorage.getItem("libro-mayor-state") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(raw["moneda"]).toBe("ARS");
    expect(raw["codigoValor"]).toBe("777");
  });

  it("vacíos caen a defaults Groq y moneda inválida a BOB", () => {
    cfgBaseUrl.value = "";
    cfgModel.value = "";
    cfgApiKey.value = "";
    cfgMoneda.value = "XXX";
    enviar();
    expect(state.configIA.baseUrl).toContain("groq");
    expect(state.configIA.model).toBe("qwen/qwen3.8-27b");
    expect(state.moneda).toBe("BOB");
  });

  it("pegado con espacios se persiste recortado", () => {
    cfgBaseUrl.value = "  http://nuevo  ";
    opcion("modelo-x");
    cfgApiKey.value = "  secreto \n";
    enviar();
    expect(state.configIA.baseUrl).toBe("http://nuevo");
    expect(state.configIA.apiKey).toBe("secreto");
  });
});

describe("Predeterminado", () => {
  it("resetea, repinta inputs y total", () => {
    state.configIA = { baseUrl: "xxx", model: "yyy", apiKey: "zzz" };
    state.moneda = "EUR";
    btnResetAjustes.click();
    expect(state.configIA.baseUrl).toContain("groq");
    expect(state.moneda).toBe("BOB");
    expect(cfgBaseUrl.value).toContain("groq");
    expect(cfgModel.value).toBe("qwen/qwen3.8-27b");
    expect(cfgApiKey.value).toBe("");
    expect(cfgMoneda.value).toBe("BOB");
  });
});

describe("Modelos", () => {
  const pausa = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

  function conRed(tienda: Map<unknown, unknown>, fetchFn: ReturnType<typeof vi.fn>): () => void {
    const g = globalThis as Record<string, unknown>;
    const real = { fetch: g["fetch"], caches: g["caches"], Response: g["Response"] };
    g["Response"] = class {
      readonly cuerpo: unknown;
      readonly init: unknown;
      constructor(cuerpo: unknown, init?: unknown) {
        this.cuerpo = cuerpo;
        this.init = init;
      }
    };
    g["fetch"] = fetchFn;
    const bytes = new Uint8Array([7]).buffer;
    g["caches"] = {
      open: async (): Promise<unknown> => ({
        match: async (k: unknown): Promise<unknown> => {
          const url = typeof k === "string" ? k : (k as { url: string }).url;
          return tienda.get(url) ?? undefined;
        },
        put: async (k: unknown, v: unknown): Promise<void> => {
          const cuerpo = (v as { cuerpo?: ArrayBuffer }).cuerpo;
          tienda.set(k, {
            arrayBuffer: async () => bytes,
            headers: { get: () => String(cuerpo?.byteLength ?? 0) },
          });
        },
        keys: async (): Promise<unknown[]> => [...tienda.keys()].map((url) => ({ url })),
      }),
      delete: async (): Promise<boolean> => {
        const habia = tienda.size > 0;
        tienda.clear();
        return habia;
      },
    };
    return () => {
      g["fetch"] = real.fetch;
      g["Response"] = real.Response;
      if (real.caches === undefined) delete g["caches"];
      else g["caches"] = real.caches;
    };
  }

  it("abrir sin caché pinta no descargados", async () => {
    const g = globalThis as Record<string, unknown>;
    const realCaches = g["caches"];
    delete g["caches"];
    try {
      btnAjustes.click();
      await pausa();
      expect(estadoModelos.textContent).toBe("Modelos: no descargados");
    } finally {
      if (realCaches !== undefined) g["caches"] = realCaches;
      modalAjustes.close();
    }
  });

  it("descargar pinta el tamaño y borrar lo vacía", async () => {
    const tienda = new Map<unknown, unknown>();
    const grande = new ArrayBuffer(60_000_000);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => grande,
    }));
    const restaurar = conRed(tienda, fetchFn);
    try {
      btnDescargarModelos.click();
      await pausa();
      // docaligner + det + rec = 3 entradas de ~57MB.
      expect(estadoModelos.textContent).toBe("Modelos: ~172 MB en este navegador");
      btnBorrarModelos.click();
      await pausa();
      expect(estadoModelos.textContent).toContain("borrados");
      expect(tienda.size).toBe(0);
      btnBorrarModelos.click();
      await pausa();
      expect(estadoModelos.textContent).toContain("no había nada");
    } finally {
      restaurar();
    }
  });

  it("descarga fallida muestra la causa y libera los botones", async () => {
    const tienda = new Map<unknown, unknown>();
    const fetchFn = vi.fn(async () => {
      throw new Error("red caída");
    });
    const restaurar = conRed(tienda, fetchFn);
    try {
      btnDescargarModelos.click();
      await pausa();
      expect(estadoModelos.textContent).toContain("red caída");
      expect(btnDescargarModelos.disabled).toBe(false);
      expect(btnBorrarModelos.disabled).toBe(false);
    } finally {
      restaurar();
    }
  });

  it("caché que lanza pinta error de consulta", async () => {
    const g = globalThis as Record<string, unknown>;
    const realCaches = g["caches"];
    g["caches"] = {
      open: async (): Promise<unknown> => {
        throw new Error("denegado");
      },
    };
    try {
      btnAjustes.click();
      await pausa();
      expect(estadoModelos.textContent).toContain("no se pudo consultar");
    } finally {
      if (realCaches === undefined) delete g["caches"];
      else g["caches"] = realCaches;
      modalAjustes.close();
    }
  });

  it("borrado que falla muestra la causa", async () => {
    const g = globalThis as Record<string, unknown>;
    const realCaches = g["caches"];
    g["caches"] = {
      open: async (): Promise<unknown> => ({}),
      delete: async (): Promise<boolean> => {
        throw new Error("denegado");
      },
    };
    try {
      btnBorrarModelos.click();
      await pausa();
      expect(estadoModelos.textContent).toContain("no se pudo borrar");
      expect(estadoModelos.textContent).toContain("denegado");
    } finally {
      if (realCaches === undefined) delete g["caches"];
      else g["caches"] = realCaches;
    }
  });
});

describe("selector modelos LLM", () => {
  const pausa = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

  it("refresh lista y conserva el actual si falta", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [{ id: "nuevo-1" }] }),
      }) as unknown as Response) as typeof fetch;
    try {
      state.configIA = {
        baseUrl: "https://x.test/v1/chat/completions",
        model: "viejo",
        apiKey: "k",
      };
      btnAjustes.click();
      btnRefrescarModelos.click();
      await pausa();
      const valores = [...cfgModel.options].map((o) => o.value);
      expect(valores).toContain("nuevo-1");
      expect(valores).toContain("viejo");
      expect(estadoModelosIA.textContent).toContain("(chat)");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("manual persiste el escrito", () => {
    btnAjustes.click();
    cfgModel.value = "__manual__";
    cfgModel.dispatchEvent(new Event("change", { bubbles: true }));
    cfgModelManual.value = "custom-x";
    formAjustes.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(state.configIA.model).toBe("custom-x");
    modalAjustes.close();
  });

  it("CORS conserva lista previa y avisa", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [{ id: "bueno-1" }] }),
      }) as unknown as Response) as typeof fetch;
    try {
      state.configIA = {
        baseUrl: "https://x.test/v1/chat/completions",
        model: "viejo",
        apiKey: "k",
      };
      btnAjustes.click();
      btnRefrescarModelos.click();
      await pausa();
      globalThis.fetch = (async (): Promise<Response> => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch;
      btnRefrescarModelos.click();
      await pausa();
      const valores = [...cfgModel.options].map((o) => o.value);
      expect(valores).toContain("bueno-1");
      expect(estadoModelosIA.textContent).toContain("CORS");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("zen muestra sugeridos sin red", () => {
    state.configIA = {
      baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
      model: "",
      apiKey: "k",
    };
    btnAjustes.click();
    const valores = [...cfgModel.options].map((o) => o.value);
    expect(valores).toContain("muse-spark-1.3-contributor");
    modalAjustes.close();
  });

  it("cambiar de endpoint no mezcla la lista del anterior", async () => {
    const real = globalThis.fetch;
    const llamadas: string[] = [];
    globalThis.fetch = (async (u: unknown): Promise<Response> => {
      llamadas.push(String(u));
      const id = String(u).includes("a.test") ? "solo-a" : "solo-b";
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [{ id }] }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      state.configIA = { baseUrl: "https://a.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      await pausa();
      expect([...cfgModel.options].map((o) => o.value)).toContain("solo-a");
      modalAjustes.close();
      state.configIA = { baseUrl: "https://b.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      await pausa();
      const valores = [...cfgModel.options].map((o) => o.value);
      expect(valores).toContain("solo-b");
      expect(valores).not.toContain("solo-a");
      expect(llamadas.length).toBeGreaterThan(1); // refetcheó B, no reusó A
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("fallo en B no ofrece la lista cacheada de A", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: unknown): Promise<Response> => {
      if (String(u).includes("a.test"))
        return {
          ok: true,
          status: 200,
          json: (): Promise<unknown> => Promise.resolve({ data: [{ id: "solo-a" }] }),
        } as unknown as Response;
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    try {
      state.configIA = { baseUrl: "https://a.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      await pausa();
      modalAjustes.close();
      state.configIA = { baseUrl: "https://b.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      await pausa();
      const valores = [...cfgModel.options].map((o) => o.value);
      expect(valores).not.toContain("solo-a");
      expect(estadoModelosIA.textContent).toContain("no lista desde navegador");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("cargas solapadas: solo escribe la última", async () => {
    const real = globalThis.fetch;
    let resolver!: (v: Response) => void;
    let n = 0;
    const lista = (id: string): Response =>
      ({
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [{ id }] }),
      }) as unknown as Response;
    globalThis.fetch = (() => {
      n += 1;
      if (n === 1)
        return new Promise<Response>((res) => {
          resolver = res;
        });
      return Promise.resolve(lista("segundo"));
    }) as typeof fetch;
    try {
      state.configIA = {
        baseUrl: "https://race.test/v1/chat/completions",
        model: "m",
        apiKey: "k",
      };
      btnAjustes.click(); // carga #1 en vuelo
      modalAjustes.close();
      btnAjustes.click(); // carga #2 resuelve primero
      await pausa();
      resolver(lista("primero")); // la rancia llega tarde
      await pausa();
      const valores = [...cfgModel.options].map((o) => o.value);
      expect(valores).toContain("segundo");
      expect(valores).not.toContain("primero");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("probar recorta base y key antes del fetch", async () => {
    const real = globalThis.fetch;
    const vistos: { url: string; auth: string }[] = [];
    let n = 0;
    globalThis.fetch = (async (u: unknown, o?: RequestInit): Promise<Response> => {
      n += 1;
      if (n === 1)
        return {
          ok: true,
          status: 200,
          json: (): Promise<unknown> => Promise.resolve({ data: [] }),
        } as unknown as Response;
      vistos.push({
        url: String(u),
        auth: String((o?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""),
      });
      return {
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ choices: [] }),
      } as unknown as Response;
    }) as typeof fetch;
    try {
      state.configIA = { baseUrl: "https://t.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      await pausa();
      cfgBaseUrl.value = "  https://t.test/v1/chat/completions  ";
      cfgApiKey.value = "  k-secreta \n";
      btnProbarIA.click();
      await pausa();
      expect(vistos).toHaveLength(1);
      expect(vistos[0]?.url).toBe("https://t.test/v1/chat/completions");
      expect(vistos[0]?.auth).toBe("Bearer k-secreta");
      expect(estadoPruebaIA.textContent).toContain("✓");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("probar en vuelo se descarta si cambia la key", async () => {
    const real = globalThis.fetch;
    let resolver!: (v: Response) => void;
    let n = 0;
    const okVacio = (): Response =>
      ({
        ok: true,
        status: 200,
        json: (): Promise<unknown> => Promise.resolve({ data: [] }),
      }) as unknown as Response;
    globalThis.fetch = (() => {
      n += 1;
      if (n === 2)
        return new Promise<Response>((res) => {
          resolver = res;
        });
      return Promise.resolve(okVacio());
    }) as typeof fetch;
    try {
      state.configIA = {
        baseUrl: "https://ping.test/v1/chat/completions",
        model: "m",
        apiKey: "k1",
      };
      btnAjustes.click();
      await pausa();
      btnProbarIA.click(); // ping #1 en vuelo (fetch #2)
      cfgApiKey.value = "k2";
      cfgApiKey.dispatchEvent(new Event("input", { bubbles: true })); // invalida
      resolver(okVacio());
      await pausa();
      expect(estadoPruebaIA.textContent).toBe("Sin probar.");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("razonamiento: kimi reducido, genérico completo, No segundo y persiste", () => {
    state.configIA = {
      baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
      model: "kimi-k3",
      apiKey: "k",
    };
    btnAjustes.click();
    expect([...cfgRazonamiento.options].map((o) => o.value)).toEqual([
      "auto",
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(cfgRazonamiento.options[1]?.text).toBe("No razonar");
    opcion("muse-spark-1.3-contributor");
    cfgModel.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...cfgRazonamiento.options].map((o) => o.value)).toContain("medium");
    cfgRazonamiento.value = "none";
    formAjustes.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(state.configIA.razonamiento).toBe("none");
    modalAjustes.close();
  });
});

describe("probar conexión", () => {
  const pausa = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

  it("sin key deshabilita y queda sin probar", () => {
    state.configIA = { baseUrl: "https://x.test/v1/chat/completions", model: "m", apiKey: "" };
    btnAjustes.click();
    expect(btnProbarIA.disabled).toBe(true);
    expect(estadoPruebaIA.textContent).toBe("Sin probar.");
    modalAjustes.close();
  });

  it("ok pinta ✓ y marca válido; error pinta ✗ e invalida", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> =>
      ({ ok: true, status: 200 }) as Response) as typeof fetch;
    try {
      state.configIA = { baseUrl: "https://x.test/v1/chat/completions", model: "m", apiKey: "k" };
      btnAjustes.click();
      btnProbarIA.click();
      await pausa();
      expect(estadoPruebaIA.textContent).toContain("✓ OK");
      expect(cfgApiKey.getAttribute("aria-invalid")).toBe("false");
      globalThis.fetch = (async (): Promise<Response> => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch;
      btnProbarIA.click();
      await pausa();
      expect(estadoPruebaIA.textContent).toContain("✗");
      expect(estadoPruebaIA.textContent).toContain("CORS");
      expect(cfgApiKey.getAttribute("aria-invalid")).toBe("true");
    } finally {
      globalThis.fetch = real;
      modalAjustes.close();
    }
  });

  it("cambiar la key invalida la prueba", () => {
    state.configIA = { baseUrl: "https://x.test/v1/chat/completions", model: "m", apiKey: "k" };
    btnAjustes.click();
    cfgApiKey.value = "otra";
    cfgApiKey.dispatchEvent(new Event("input", { bubbles: true }));
    expect(estadoPruebaIA.textContent).toBe("Sin probar.");
    modalAjustes.close();
  });
});
