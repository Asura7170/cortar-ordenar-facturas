/* Estado global + persistencia + operaciones puras de estado. */
import type { Comprobante, EstadoApp, Hoja, LayoutId, Moneda, PersistedState } from './types';
import { layoutDe } from './ui/layout';

export const LS_KEY = 'libro-mayor-state';

export const MONEDAS: Record<Moneda, { simbolo: string }> = {
  USD: { simbolo: 'US$' },
  ARS: { simbolo: 'AR$' },
  EUR: { simbolo: '€' },
};

export const state: EstadoApp = {
  hojas: [],
  codigoActivo: false,
  codigoLongitud: 6,
  codigoValor: '',
  configIA: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  moneda: 'USD',
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

export function guardar(): void {
  const persist: PersistedState = {
    codigoActivo: state.codigoActivo,
    codigoLongitud: state.codigoLongitud,
    codigoValor: state.codigoValor,
    moneda: state.moneda,
    configIA: state.configIA,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(persist));
}

export function isMoneda(v: unknown): v is Moneda {
  return v === 'USD' || v === 'ARS' || v === 'EUR';
}

function isPersistedState(v: unknown): v is PersistedState {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p['codigoActivo'] === 'boolean'
    && typeof p['codigoLongitud'] === 'number'
    && typeof p['codigoValor'] === 'string'
    && isMoneda(p['moneda']);
}

export function cargar(): void {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const p: unknown = JSON.parse(raw);
    if (!isPersistedState(p)) return; // estado corrupto o de otra versión: ignorar
    state.codigoActivo = p.codigoActivo;
    state.codigoLongitud = Math.max(1, Math.min(12, Math.floor(p.codigoLongitud) || 6));
    state.codigoValor = p.codigoValor;
    state.moneda = p.moneda;
    const ia = (p as { configIA?: unknown }).configIA;
    if (typeof ia === 'object' && ia !== null) {
      const c = ia as Record<string, unknown>;
      if (typeof c['baseUrl'] === 'string') state.configIA.baseUrl = c['baseUrl'];
      if (typeof c['model'] === 'string') state.configIA.model = c['model'];
      if (typeof c['apiKey'] === 'string') state.configIA.apiKey = c['apiKey'];
    }
  } catch { /* estado corrupto: ignorar */ }
}

export function crearHoja(layoutId: LayoutId = 'u4x2'): Hoja {
  const l = layoutDe(layoutId);
  return { id: nextHojaId(), layout: layoutId, slots: Array<Hoja['slots'][number]>(l.total).fill(null) };
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
  state.hojas = Iterator.from(state.hojas).filter((h) => h.slots.some(Boolean)).toArray();
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
    h.slots = Array<Hoja['slots'][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
  }
  while (pos < items.length) {
    const last = state.hojas[state.hojas.length - 1];
    const h = crearHoja(last?.layout ?? 'u4x2');
    const cap = layoutDe(h.layout).total;
    h.slots = Array<Hoja['slots'][number]>(cap).fill(null);
    for (let i = 0; i < cap && pos < items.length; i++) h.slots[i] = tomar();
    state.hojas.push(h);
  }
  limpiarHojas();
}
