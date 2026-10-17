/* Tests: nucleoReal con ORT falso (el glue necesita GPU/wasm; det/rec bajan de
   la red falsa real de docaligner). Se aserra el catch de strikes: el 2º fallo
   de sesión consecutivo expulsa det/rec (bytes muertos no sobreviven) y el
   singleton queda reutilizable (ninguna promesa podrida cacheada). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { crearFalso } = vi.hoisted(() => ({ crearFalso: vi.fn() }));
vi.mock("onnxruntime-web/webgpu", () => ({
  env: { wasm: { wasmPaths: "", numThreads: 0 } },
  Tensor: vi.fn(),
  InferenceSession: { create: crearFalso },
}));

const { obtenerNucleo } = await import("./ocr");
const { iaOk, notarSesionOk, reactivarIa } = await import("./docaligner");

// Mismas plantillas que las consts privadas de ocr.ts (no exportadas a propósito).
const DET = `${import.meta.env.BASE_URL}models/ocr/det.onnx`;
const REC = `${import.meta.env.BASE_URL}models/ocr/rec.onnx`;
const BUF_DET = new ArrayBuffer(5_000_000); // minBytes det (ocr.ts)
const BUF_REC = new ArrayBuffer(10_000_000); // minBytes rec

// jsdom no trae Response: dummy con arrayBuffer (el put falso ignora el init).
class RespuestaFalsa {
  readonly cuerpo: ArrayBuffer;
  constructor(cuerpo: ArrayBuffer) {
    this.cuerpo = cuerpo;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this.cuerpo);
  }
}

type Tienda = Map<string, RespuestaFalsa>;
const g = globalThis as Record<string, unknown>;
const real = { fetch: g["fetch"], caches: g["caches"], Response: g["Response"] };
let tienda: Tienda;
let subida: ReturnType<typeof vi.fn>;

function claveDe(k: unknown): string {
  return typeof k === "string" ? k : (k as { url: string }).url;
}

beforeEach(() => {
  tienda = new Map();
  subida = vi.fn(async (url: unknown): Promise<unknown> => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => (String(url).endsWith("det.onnx") ? BUF_DET : BUF_REC),
  }));
  g["Response"] = RespuestaFalsa;
  g["fetch"] = subida;
  g["caches"] = {
    open: async (): Promise<unknown> => ({
      match: async (k: unknown): Promise<unknown> => tienda.get(claveDe(k)),
      put: async (k: unknown, r: unknown): Promise<void> => {
        tienda.set(claveDe(k), r as RespuestaFalsa);
      },
      keys: async (): Promise<Array<{ url: string }>> => [...tienda.keys()].map((url) => ({ url })),
      delete: async (k: unknown): Promise<boolean> => tienda.delete(claveDe(k)),
    }),
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  crearFalso.mockReset().mockRejectedValue(new Error("create corrupto"));
});

afterEach(() => {
  g["fetch"] = real.fetch;
  g["Response"] = real.Response;
  if (real.caches === undefined) delete g["caches"];
  else g["caches"] = real.caches;
  vi.restoreAllMocks();
  reactivarIa();
  notarSesionOk(DET);
  notarSesionOk(REC);
  iaOk();
});

describe("nucleoReal (ORT falso, det/rec reales en la red falsa)", () => {
  it("2 fallos de sesión consecutivos expulsan det/rec; el singleton queda vivo", async () => {
    // Foto 1: baja det/rec y create falla → strike 1 (no expulsa, no enfría).
    await expect(obtenerNucleo()).rejects.toThrow("create corrupto");
    expect(tienda.size).toBe(2);
    expect(subida).toHaveBeenCalledTimes(2);
    // Foto 2: hit limpio de los bytes cacheados (0 fetches), create falla →
    // strike 2 → el catch del núcleo expulsa AMBAS claves.
    await expect(obtenerNucleo()).rejects.toThrow("create corrupto");
    expect(tienda.size).toBe(0);
    expect(subida).toHaveBeenCalledTimes(2);
    // Foto 3: sin promesa podrida en el singleton: re-descarga y falla igual.
    // La razón sigue siendo create (el enfriamiento no se armó por un create).
    await expect(obtenerNucleo()).rejects.toThrow("create corrupto");
    expect(tienda.size).toBe(2);
    expect(subida).toHaveBeenCalledTimes(4);
  });

  it("la baja de red de rec no expulsa a det sano (strike por clave, no en bloque)", async () => {
    subida.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith("rec.onnx")) throw new Error("la bajada de rec murió");
      return { ok: true, status: 200, arrayBuffer: async () => BUF_DET };
    });
    // Bajada 1: det baja y cachea; rec falla → strike 1 SOLO de rec.
    await expect(obtenerNucleo()).rejects.toThrow("la bajada de rec murió");
    expect(tienda.size).toBe(1);
    // Bajada 2 (en enfriamiento de rec): det sirve de caché, rec fast-faila →
    // strike 2 de rec. Con el catch en bloque det otra vez golpeado habría
    // llegado a 2 strikes y su copia sana habría sido expulsada (tienda en 0).
    await expect(obtenerNucleo()).rejects.toThrow("recién falló");
    expect(tienda.size).toBe(1);
    expect([...tienda.keys()].some((k) => k.includes("det.onnx"))).toBe(true);
    // 0 fetches en el 2º intento: det de caché y rec en enfriamiento ±1min.
    expect(subida).toHaveBeenCalledTimes(2);
  });
});
