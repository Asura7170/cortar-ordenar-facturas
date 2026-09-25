/* JEV (TypeSafe System One) — vía de desempate cuando el regex ve >1 distinto.
   Flujo: ocr → regex (1 distinto = ok sin red, 0 = manual, >1 = JEV → LLM en lote).
   JEV siempre recibe >1 candidato, nunca 0/1. Sin dependencias nuevas. */
import type { Cents } from "../types";
import { parsearMonto } from "../ui/monto";

export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 15_000;
export const JEV_MAX_CANDIDATOS = 40;
export const JEV_KEY_SS = "jev-api-key";

/** Formato X,XXX.XX exigido antes de mostrar (nunca se pinta basura). */
export const MONTO_RE: RegExp = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;

export type FetchFn = typeof fetch;

export interface CandidatoJev {
  readonly id: string;
  readonly valor: string;
  readonly contexto: string;
  readonly posPct: number;
  readonly nearMoney: "yes" | "no";
}

export interface FacturaJev {
  readonly id: number;
  readonly contenido: string;
}

export interface JevRequest {
  readonly state: { readonly contenido: string; readonly candidatos: readonly CandidatoJev[] };
  readonly model: string;
  readonly questions: {
    readonly total: {
      readonly type: "choice";
      readonly instructions: string;
      readonly criteria: Record<string, string>;
    };
  };
  readonly meta: { readonly id: number; readonly pool: readonly CandidatoJev[] };
}

const TOTAL_INSTRUCTIONS =
  "Select the single final payable amount from `candidatos` using `contenido` as truth. Final means total to be paid/transferred after discounts/taxes, not line partials, unit prices, ICE/tax alone, discount, account numbers or dates. Prefer value marked as final/total/due/transferred/paid, especially near end of `contenido`. If none qualifies choose none.";

const MONEY_RE = /(?:Bs\.?|BOB|\$)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})(?!\d)/g;
const NEAR_RE =
  /total|cobrar|monto|importe|transfer|pag|yape|\bbs\.?|sub-?total|ice|descuento|debit|abon/i;

export function extractCandidates(contenido = ""): CandidatoJev[] {
  MONEY_RE.lastIndex = 0;
  const out: CandidatoJev[] = [];
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = MONEY_RE.exec(contenido)) !== null) {
    const valor = m[1] ?? "";
    const pos = m.index + m[0].indexOf(valor);
    const contexto = contenido
      .slice(Math.max(0, pos - 40), pos + valor.length + 40)
      .replace(/\s+/g, " ")
      .trim();
    out.push({
      id: `c${n++}`,
      valor,
      contexto,
      posPct: Math.round((pos / Math.max(1, contenido.length)) * 100),
      nearMoney: NEAR_RE.test(contexto) ? "yes" : "no",
    });
  }
  return out;
}

// ponytail: ≤40/request; con Tier1 se recorta por relevancia, sin Tier1 los últimos 40.
export function pickPool(candidatos: readonly CandidatoJev[]): CandidatoJev[] {
  if (candidatos.length <= JEV_MAX_CANDIDATOS) return [...candidatos];
  const tier1 = candidatos.filter((c) => c.nearMoney === "yes");
  return tier1.length > 0
    ? tier1.slice(-JEV_MAX_CANDIDATOS)
    : [...candidatos].slice(-JEV_MAX_CANDIDATOS);
}

export function buildRequest(factura: FacturaJev): JevRequest {
  const contenido = String(factura.contenido ?? "");
  const candidatos = pickPool(extractCandidates(contenido));
  const criteria: Record<string, string> = {};
  for (const c of candidatos) {
    criteria[c.id] =
      `Valor ${c.valor} seen as '${c.contexto}' [pos ${c.posPct}% | nearMoney ${c.nearMoney}]`;
  }
  criteria["none"] = "No candidate is the final total";
  return {
    state: { contenido, candidatos },
    model: JEV_MODEL,
    questions: { total: { type: "choice", instructions: TOTAL_INSTRUCTIONS, criteria } },
    meta: { id: factura.id, pool: candidatos },
  };
}

export function formatMonto(valor: unknown): string | null {
  const n = Number(String(valor).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function resolveTotal(req: JevRequest, answer: unknown): string | null {
  const byId = new Map(req.meta.pool.map((c) => [c.id, c.valor] as const));
  const choice = (answer as { choice?: unknown } | null)?.choice;
  if (typeof choice === "string" && choice !== "none" && byId.has(choice)) {
    const conf = (answer as { confidence?: unknown } | null)?.confidence;
    if (typeof conf !== "number" || conf >= 0.7) {
      const v = byId.get(choice);
      if (v !== undefined) return formatMonto(v);
    }
  }
  // Sin elección válida no se adivina: null → "respuesta inválida" → cae al LLM.
  return null;
}

// ponytail: fast-path offline — 1 único distinto (repetido N veces vale) => total sin red.
export function extraerRapidoCents(contenido = ""): Cents | null {
  let unico: Cents | null = null;
  let vistos = 0;
  for (const c of extractCandidates(contenido)) {
    const cents = parsearMonto(c.valor);
    if (cents === null) continue;
    if (vistos === 0) unico = cents;
    else if (unico !== cents) return null;
    vistos++;
  }
  return vistos > 0 ? unico : null;
}

/* Key JEV: persiste en localStorage como la del LLM (ver state.guardarAjustes);
   sessionStorage solo como migración de la época anterior; nunca logs. */
let memoria = "";
let cargada = false;

export function getJevKey(): string {
  if (!cargada) {
    cargada = true;
    try {
      memoria = localStorage.getItem(JEV_KEY_SS) ?? sessionStorage.getItem(JEV_KEY_SS) ?? "";
    } catch {
      memoria = "";
    }
  }
  return memoria;
}

export function setJevKey(key: string): void {
  memoria = key.trim();
  cargada = true;
  try {
    if (memoria !== "") localStorage.setItem(JEV_KEY_SS, memoria);
    else {
      localStorage.removeItem(JEV_KEY_SS);
      sessionStorage.removeItem(JEV_KEY_SS);
    }
  } catch {
    /* sin almacenamiento: queda en memoria */
  }
}

export function clearJevKey(): void {
  memoria = "";
  cargada = true;
  try {
    localStorage.removeItem(JEV_KEY_SS);
    sessionStorage.removeItem(JEV_KEY_SS);
  } catch {
    /* sin almacenamiento */
  }
}

/** POST mismo-origen /api/jev (Pages `_redirects` en prod, proxy vite en dev)
    con Bearer del usuario; `buildRequest` congela el prompt en cliente.
    Valida X,XXX.XX; 1 reintento 429/529 honrando retry-after (tope 5s). */
export async function llamarJev(
  factura: FacturaJev,
  apiKey: string,
  fetchFn: FetchFn = fetch,
  reintento = true,
): Promise<{ total: string; source: string }> {
  const key = apiKey.trim();
  if (key === "") throw new Error("sin key JEV");
  const req = buildRequest(factura);
  // ponytail: sin recorte de state — el texto ya viene topado (limpiarTexto ≤1800).
  const cuerpo = { state: req.state, model: req.model, questions: req.questions };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetchFn("/api/jev", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(cuerpo),
      signal: ctrl.signal,
    });
    if ((res.status === 429 || res.status === 529) && reintento) {
      // ponytail: tope 5s — un retry-after gigante no cuelga el lote
      const espera = Math.min(Number(res.headers.get("retry-after")) * 1000 || 1000, 5000);
      await new Promise((r) => setTimeout(r, espera));
      clearTimeout(t);
      return llamarJev(factura, key, fetchFn, false);
    }
    if (!res.ok) throw new Error(`/api/jev ${res.status}`);
    const data = (await res.json()) as { answers?: { total?: unknown }; model?: unknown };
    const total = resolveTotal(req, data.answers?.total);
    if (typeof total !== "string" || !MONTO_RE.test(total)) throw new Error("respuesta inválida");
    const modelo = typeof data.model === "string" && data.model !== "" ? data.model : JEV_MODEL;
    return { total, source: `jev:${modelo}` };
  } finally {
    clearTimeout(t);
  }
}

export interface ResultadoJev {
  readonly ok: boolean;
  readonly modelo: string;
  readonly ms: number;
  readonly total: string;
  readonly mensaje: string;
}

/** Sonda mínima (1 inferencia real con factura sintética): valida la key y mide
    ms para el botón Conectar. Nunca lanza; la key jamás va a logs. */
export async function probarJev(apiKey: string, fetchFn: FetchFn = fetch): Promise<ResultadoJev> {
  const key = apiKey.trim();
  if (key === "") return { ok: false, modelo: "", ms: 0, total: "", mensaje: "Falta API key JEV." };
  const ini = performance.now();
  try {
    const r = await llamarJev({ id: 0, contenido: "Total: 1.00" }, key, fetchFn);
    return {
      ok: true,
      modelo: r.source,
      ms: Math.round(performance.now() - ini),
      total: r.total,
      mensaje: "",
    };
  } catch (e: unknown) {
    const ms = Math.round(performance.now() - ini);
    if (e instanceof DOMException && e.name === "AbortError")
      return { ok: false, modelo: "", ms, total: "", mensaje: "timeout (15s)" };
    const m = e instanceof Error ? e.message : "error";
    if (m.includes("401"))
      return { ok: false, modelo: "", ms, total: "", mensaje: "clave inválida (401)" };
    if (m.includes("Failed to fetch"))
      return { ok: false, modelo: "", ms, total: "", mensaje: "sin red/CORS" };
    return { ok: false, modelo: "", ms, total: "", mensaje: m };
  }
}
