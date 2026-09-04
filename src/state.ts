/* Estado global + persistencia + operaciones puras de estado. */
import type {
  Comprobante,
  ConfigIA,
  EstadoApp,
  Hoja,
  LayoutId,
  Moneda,
  PersistedState,
} from "./types";
import { layoutDe } from "./ui/layout";

export const LS_KEY = "libro-mayor-state";

export const MONEDAS: Record<Moneda, { simbolo: string }> = {
  USD: { simbolo: "US$" },
  ARS: { simbolo: "AR$" },
  EUR: { simbolo: "€" },
  BOB: { simbolo: "Bs" },
};

export const CONFIG_IA_DEFAULT: ConfigIA = {
  baseUrl: "https://api.groq.com/openai/v1/chat/completions",
  model: "qwen/qwen3.8-27b",
  apiKey: "",
};
export const MONEDA_DEFAULT: Moneda = "USD";

export const state: EstadoApp = {
  hojas: [],
  codigoActivo: false,
  codigoLongitud: 6,
  codigoValor: "",
  configIA: { ...CONFIG_IA_DEFAULT },
  moneda: MONEDA_DEFAULT,
  colaEnProceso: false,
  modoOcr: false,
};

let seq = 0;
let seqHoja = 0;

export function nextComprobanteId(): number {
  return ++seq;
}

export function nextHojaId(): number {
  return ++seqHoja;
}

function leerBlob(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const p: unknown = JSON.parse(raw);
    return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Solo la ventana Código: el switch arma el guardado, editar longitud/valor lo dispara.
export function guardarCodigo(): void {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      ...leerBlob(),
      codigoActivo: state.codigoActivo,
      codigoLongitud: state.codigoLongitud,
      codigoValor: state.codigoValor,
    }),
  );
}

// Solo la ventana Ajustes (Guardar y Predeterminado): el código queda intacto.
export function guardarAjustes(): void {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      ...leerBlob(),
      moneda: state.moneda,
      configIA: state.configIA,
    }),
  );
}

// Switch OFF: la ventana Código retira lo suyo y deja ajustes/LS limpio.
export function borrarCodigo(): void {
  const blob = leerBlob();
  delete blob["codigoActivo"];
  delete blob["codigoLongitud"];
  delete blob["codigoValor"];
  if (Object.keys(blob).length === 0) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(blob));
}

export function isMoneda(v: unknown): v is Moneda {
  return v === "USD" || v === "ARS" || v === "EUR" || v === "BOB";
}

// Vuelve los ajustes del modal a sus valores de fábrica (código y tema intactos).
export function restablecerAjustes(): void {
  state.configIA = { ...CONFIG_IA_DEFAULT };
  state.moneda = MONEDA_DEFAULT;
  guardarAjustes();
}

function isPersistedState(v: unknown): v is PersistedState {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  // Cada ventana guarda lo suyo: moneda es opcional (blobs legacy solo-código
  // de guardarCodigo() sin moneda). Si viene, debe ser válida.
  if ("moneda" in p && !isMoneda(p["moneda"])) return false;
  return (
    typeof p["codigoActivo"] === "boolean" ||
    typeof p["codigoLongitud"] === "number" ||
    typeof p["codigoValor"] === "string" ||
    isMoneda(p["moneda"]) ||
    typeof p["configIA"] === "object"
  );
}

export function cargar(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const p: unknown = JSON.parse(raw);
    if (!isPersistedState(p)) return; // estado corrupto o de otra versión: ignorar
    const r = p as Record<string, unknown>;
    state.codigoActivo = typeof r["codigoActivo"] === "boolean" ? r["codigoActivo"] : false;
    const lon = r["codigoLongitud"];
    state.codigoLongitud =
      typeof lon === "number" ? Math.max(1, Math.min(12, Math.floor(lon) || 6)) : 6;
    state.codigoValor = typeof r["codigoValor"] === "string" ? r["codigoValor"] : "";
    if (isMoneda(r["moneda"])) state.moneda = r["moneda"]; // ausente en blobs legacy: se conserva
    const ia = (p as { configIA?: unknown }).configIA;
    if (typeof ia === "object" && ia !== null) {
      const c = ia as Record<string, unknown>;
      if (typeof c["baseUrl"] === "string") state.configIA.baseUrl = c["baseUrl"];
      if (typeof c["model"] === "string") state.configIA.model = c["model"];
      if (typeof c["apiKey"] === "string") state.configIA.apiKey = c["apiKey"];
    }
  } catch {
    /* estado corrupto: ignorar */
  }
}

export function crearHoja(layoutId: LayoutId = "u4x2"): Hoja {
  const l = layoutDe(layoutId);
  return {
    id: nextHojaId(),
    layout: layoutId,
    slots: Array<Hoja["slots"][number]>(l.total).fill(null),
  };
}

export function hojaPorId(id: string | number): Hoja | undefined {
  return state.hojas.find((h) => h.id === Number(id));
}

export function buscarSlot(id: number): { hoja: Hoja; idx: number } | null {
  for (const h of state.hojas) {
    const idx = h.slots.findIndex((c) => c?.id === id);
    if (idx >= 0) return { hoja: h, idx };
  }
  return null;
}

export function limpiarHojas(): void {
  state.hojas = Iterator.from(state.hojas)
    .filter((h) => h.slots.some(Boolean))
    .toArray();
  if (state.hojas.length === 0) state.hojas.push(crearHoja());
}

// Reparte los comprobantes en orden visual respetando la capacidad de cada
// hoja: rellena consecutivamente (recompacta, sin huecos) y crea hojas al final.
export function redistribuir(): void {
  const items = Iterator.from(state.hojas)
    .flatMap((h) => Iterator.from(h.slots).filter((c) => c !== null))
    .toArray();
  let pos = 0;
  const tomar = (): Comprobante | null => {
    const item = items[pos];
    if (item === undefined) return null;
    pos++;
    return item;
  };
  for (const h of state.hojas) {
    const cap = layoutDe(h.layout).total;
    h.slots = Array<Hoja["slots"][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
  }
  while (pos < items.length) {
    const last = state.hojas[state.hojas.length - 1];
    const h = crearHoja(last?.layout ?? "u4x2");
    const cap = layoutDe(h.layout).total;
    h.slots = Array<Hoja["slots"][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
    state.hojas.push(h);
  }
  limpiarHojas();
}
