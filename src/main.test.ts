/* Tests P0: resolverTema es puro (el bootstrap de main.ts se mockea entero). */
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./state", () => ({
  cargar: vi.fn(),
  crearHoja: vi.fn(() => ({})),
  state: { hojas: [] as unknown[] },
}));
vi.mock("./ui/sheets", () => ({ initSheets: vi.fn(), renderHojas: vi.fn() }));
vi.mock("./ui/sidebar", () => ({
  agregarArchivos: vi.fn(),
  elegirArchivos: vi.fn(),
  initSidebar: vi.fn(),
  pegarEnCelda: vi.fn(),
  renderCodigo: vi.fn(),
}));
vi.mock("./ui/ocrMode", () => ({ initOcrMode: vi.fn(), renderOcrToggle: vi.fn() }));
vi.mock("./ui/settingsModal", () => ({ initSettings: vi.fn() }));
vi.mock("./ui/github", () => ({ initGithub: vi.fn() }));
vi.mock("./ui/recorte", () => ({ initRecorte: vi.fn() }));
vi.mock("./export/salidas", () => ({ initExport: vi.fn() }));
vi.mock("./utils", () => ({
  getEl: vi.fn(() => ({
    title: "",
    addEventListener: (_ev: string, fn: () => void) => {
      const g = globalThis as unknown as { __temaClicks?: Array<() => void> };
      g.__temaClicks ??= [];
      g.__temaClicks.push(fn);
    },
  })),
}));

const { resolverTema } = await import("./main");

describe("resolverTema", () => {
  it("guardado válido manda sobre el SO", () => {
    expect(resolverTema("oscuro", true, false)).toBe("oscuro");
    expect(resolverTema("claro", false, true)).toBe("claro");
  });

  it("basura no va al dataset: cae al SO o al default claro", () => {
    expect(resolverTema("sepia", true, false)).toBe("claro");
    expect(resolverTema("sepia", false, true)).toBe("oscuro");
    expect(resolverTema("sepia", false, false)).toBe("claro");
  });

  it("sin guardado sigue al SO y sin señal usa claro", () => {
    expect(resolverTema(null, true, false)).toBe("claro");
    expect(resolverTema(null, false, true)).toBe("oscuro");
    expect(resolverTema(null, false, false)).toBe("claro");
  });
});

describe("toggle con storage bloqueado", () => {
  it("aplica el tema aunque el guardado falle", () => {
    const g = globalThis as unknown as { __temaClicks?: Array<() => void> };
    const handler = g.__temaClicks?.[0];
    if (!handler) throw new Error("sin handler de tema");
    const original = localStorage.setItem.bind(localStorage);
    Object.defineProperty(localStorage, "setItem", {
      value: () => {
        throw new Error("bloqueado");
      },
      configurable: true,
    });
    try {
      document.documentElement.dataset["tema"] = "claro";
      expect(() => handler()).not.toThrow();
      expect(document.documentElement.dataset["tema"]).toBe("oscuro");
    } finally {
      Object.defineProperty(localStorage, "setItem", {
        value: original,
        configurable: true,
      });
    }
  });
});
