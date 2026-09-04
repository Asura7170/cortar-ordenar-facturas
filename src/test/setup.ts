/* Stubs que jsdom no trae + reset del estado global antes de cada test. */
import { beforeEach } from "vite-plus/test";
import { CONFIG_IA_DEFAULT, MONEDA_DEFAULT, state } from "../state";

// jsdom sin origen expone localStorage como undefined: fallback en memoria.
if (typeof localStorage === "undefined") {
  const datos = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string): string | null => datos.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        datos.set(k, String(v));
      },
      removeItem: (k: string): void => {
        datos.delete(k);
      },
      clear: (): void => {
        datos.clear();
      },
      get length(): number {
        return datos.size;
      },
      key: (i: number): string | null => [...datos.keys()][i] ?? null,
    },
    configurable: true,
    writable: true,
  });
}
// jsdom no implementa blob URLs: mock monótono para asertar creación/revoke.
let blobSeq = 0;
URL.createObjectURL = (_obj: Blob | MediaSource): string => `blob:mock-${++blobSeq}`;
URL.revokeObjectURL = (_url: string): void => {};

// jsdom no implementa navigator.clipboard.
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (_texto: string): Promise<void> => {} },
  configurable: true,
});

// jsdom no implementa <dialog> modal: emula open/returnValue + evento close.
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement): void {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string): void {
  if (returnValue !== undefined) this.returnValue = returnValue;
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};

/** Vuelve el estado global a fábrica (los ids seq siguen monótonos: usar expect.any(Number)). */
export function resetEstado(): void {
  state.hojas = [];
  state.codigoActivo = false;
  state.codigoLongitud = 6;
  state.codigoValor = "";
  state.configIA = { ...CONFIG_IA_DEFAULT };
  state.moneda = MONEDA_DEFAULT;
  state.colaEnProceso = false;
  state.modoOcr = false;
  localStorage.clear();
}

beforeEach(() => {
  resetEstado();
});
