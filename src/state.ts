/* Estado global + persistencia + operaciones puras de estado. */
import type {
  Comprobante,
  EstadoApp,
  Hoja,
  LayoutId,
  Moneda,
  PersistedState,
  PosicionCodigo,
} from "./types";
import { layoutDe } from "./ui/layout";

export const LS_KEY = "libro-mayor-state";

/** Ventana anti-resurrección tras cerrar el editor (el clic que cierra no reabre). */
export const VENTANA_CIERRE_RECORTE_MS = 350;

export const MONEDAS: Record<Moneda, { simbolo: string }> = {
  USD: { simbolo: "US$" },
  ARS: { simbolo: "AR$" },
  EUR: { simbolo: "€" },
  BOB: { simbolo: "Bs" },
};

export const MONEDA_DEFAULT: Moneda = "BOB";
export const POSICION_DEFAULT: PosicionCodigo = "inf-der";

export const state: EstadoApp = {
  hojas: [],
  codigoActivo: false,
  codigoLongitud: 6,
  codigoValor: "",
  codigoPosicion: POSICION_DEFAULT,
  moneda: MONEDA_DEFAULT,
  colaEnProceso: false,
  modoOcr: false,
  loteEnCurso: false,
  cierreRecorte: 0,
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
      codigoPosicion: state.codigoPosicion,
    }),
  );
}

// Solo la ventana Ajustes (Guardar y Restablecer): el código queda intacto.
export function guardarAjustes(): void {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      ...leerBlob(),
      moneda: state.moneda,
    }),
  );
}

// Switch OFF: la ventana Código retira lo suyo y deja ajustes/LS limpio.
export function borrarCodigo(): void {
  const blob = leerBlob();
  delete blob["codigoActivo"];
  delete blob["codigoLongitud"];
  delete blob["codigoValor"];
  delete blob["codigoPosicion"];
  if (Object.keys(blob).length === 0) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(blob));
}

export function isMoneda(v: unknown): v is Moneda {
  return v === "USD" || v === "ARS" || v === "EUR" || v === "BOB";
}

// Vuelve los ajustes del modal a sus valores de fábrica (código y tema intactos).
export function restablecerAjustes(): void {
  state.moneda = MONEDA_DEFAULT;
  guardarAjustes();
}

export function isPosicionCodigo(v: unknown): v is PosicionCodigo {
  return v === "sup-izq" || v === "sup-der" || v === "inf-izq" || v === "inf-der";
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
    typeof p["codigoPosicion"] === "string" ||
    isMoneda(p["moneda"])
  );
}

/** Limpieza de la era IA: claves LLM/JEV sin dueño se borran (nunca persisten secretos muertos). */
function limpiarClavesIa(): void {
  localStorage.removeItem("jev-api-key");
  try {
    sessionStorage.removeItem("jev-api-key");
  } catch {
    /* sin sessionStorage: nada que limpiar */
  }
}

/** Sobrante de la era IA: se retira del blob (el resto del estado se conserva). */
function retirarConfigIa(r: Record<string, unknown>): void {
  if (!("configIA" in r)) return;
  delete r["configIA"];
  if (Object.keys(r).length === 0) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, JSON.stringify(r));
}

/** Ventana Código: booleans y números con clamps (blobs legacy caen al default). */
function aplicarCodigo(r: Record<string, unknown>): void {
  state.codigoActivo = typeof r["codigoActivo"] === "boolean" ? r["codigoActivo"] : false;
  const lon = r["codigoLongitud"];
  state.codigoLongitud =
    typeof lon === "number" ? Math.max(1, Math.min(12, Math.floor(lon) || 6)) : 6;
  state.codigoValor = typeof r["codigoValor"] === "string" ? r["codigoValor"] : "";
  // Blobs legacy o basura: la esquina cae al default (inferior derecha).
  state.codigoPosicion = isPosicionCodigo(r["codigoPosicion"])
    ? r["codigoPosicion"]
    : POSICION_DEFAULT;
}

export function cargar(): void {
  try {
    // Limpieza de la era IA: claves LLM/JEV sin dueño se borran (nunca persisten secretos muertos).
    limpiarClavesIa();
    // El blob parseado: raw ausente / JSON roto / no-objeto llegan como {} y
    // el guard isPersistedState los ignora (sin escribir estado ni storage):
    // el re-parseo propio era un duplicado de leerBlob().
    const r = leerBlob();
    retirarConfigIa(r);
    if (!isPersistedState(r)) return; // estado corrupto o de otra versión: ignorar
    aplicarCodigo(r);
    if (isMoneda(r["moneda"])) state.moneda = r["moneda"]; // ausente en blobs legacy: se conserva
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

// ponytail: lookup sin allocar el array de aplanar() (handlers click/change).
export function obtenerComprobante(id: number): Comprobante | undefined {
  const slot = buscarSlot(id);
  return slot ? (slot.hoja.slots[slot.idx] ?? undefined) : undefined;
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
  // ponytail: cada llamada ocurre con pos < items.length ⇒ el índice es válido.
  const tomar = (): Comprobante => {
    const item = items[pos] as Comprobante;
    pos++;
    return item;
  };
  for (const h of state.hojas) {
    const cap = layoutDe(h.layout).total;
    h.slots = Array<Hoja["slots"][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
  }
  while (pos < items.length) {
    // ponytail: el while implica hojas no vacías ⇒ hay última con layout.
    const ultimo = state.hojas[state.hojas.length - 1] as Hoja;
    const h = crearHoja(ultimo.layout);
    const cap = layoutDe(h.layout).total;
    h.slots = Array<Hoja["slots"][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
    state.hojas.push(h);
  }
  limpiarHojas();
}
