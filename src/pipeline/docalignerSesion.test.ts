/* Tests P1: crearSesion con ORT falso (el glue real necesita GPU/wasm + 79MB).
   El resto del módulo va en real (descarga, latch, reintentos, expulsión).
   La descarga se alimenta con fetch stubbeado (el mock parcial no sirve:
   crearSesion cierra sobre el descargarPesos local, no sobre el export). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { crearFalso } = vi.hoisted(() => ({ crearFalso: vi.fn() }));
vi.mock("onnxruntime-web/webgpu", () => ({
  env: { wasm: { wasmPaths: "", numThreads: 0 } },
  Tensor: vi.fn(),
  InferenceSession: { create: crearFalso },
}));

const { obtenerSesion, reintentarEps } = await import("./docaligner");

// Umbral de descargarPesos (50MB): un solo buffer reutilizado por escenario.
const PESOS = new ArrayBuffer(50_000_000);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    arrayBuffer: async () => PESOS,
  } as Response);
  reintentarEps();
  crearFalso.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sesionFalsa(run: () => Promise<unknown>): unknown {
  return { inputNames: [], outputNames: [], run };
}

describe("crearSesion (ORT falso, resto real)", () => {
  it("EPs caídos hacen latch y sin EPs lanza sin reintentar", async () => {
    crearFalso.mockRejectedValue(new Error("GPU muerta"));
    await expect(obtenerSesion()).rejects.toThrow("GPU muerta");
    // Latch: el siguiente intento no llama a create (los dos EPs ya cayeron).
    crearFalso.mockClear();
    await expect(obtenerSesion()).rejects.toThrow("ORT sin proveedor");
    expect(crearFalso).not.toHaveBeenCalled();
  });

  it("peso corrupto expulsa el peso y reintenta", async () => {
    crearFalso.mockRejectedValue(new Error("modelo corrupto en X"));
    await expect(obtenerSesion()).rejects.toThrow("modelo corrupto");
  });

  it("crea sesión e infiere con nombres por defecto", async () => {
    const runFalso = vi.fn(async (): Promise<unknown> => ({
      heatmap: { data: new Float32Array([1]), dims: [1, 1] },
    }));
    crearFalso.mockResolvedValue(sesionFalsa(runFalso) as never);
    const sesion = await obtenerSesion();
    await expect(sesion.inferir(new Float32Array([1, 2, 3]))).resolves.toEqual({
      datos: new Float32Array([1]),
      dims: [1, 1],
    });
    runFalso.mockResolvedValueOnce({});
    await expect(sesion.inferir(new Float32Array([1, 2, 3]))).rejects.toThrow("sin salida");
  });
});
