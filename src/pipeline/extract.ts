/* Extracción del TOTAL con LLM openai-compatible — 1 llamada por lote.
   Auto al drenar la cola + botón Reintentar IA. Solo completa montos en
   null: lo manual/corregido siempre gana (incluso si se escribe durante el fetch).
   La suma total la hace el código (sumaTotal); al LLM nunca se le pide sumar. */
import { buscarSlot, state } from "../state";
import type { Cents, Comprobante, ConfigIA } from "../types";
import { aplanar, parsearMonto } from "../ui/monto";
import { renderHojas } from "../ui/sheets";
import { sanear } from "../utils";

export const MAX_TEXTO = 1800;
export const MAX_CHARS_LOTE = 12000;
export const MAX_ITEMS_LLAMADA = 25;

const SISTEMA =
  'Eres un extractor de totales de facturas. Para cada bloque [#N] devolvé el TOTAL a pagar (total, importe total, total a pagar). Ignorá subtotal, IVA, propina y vuelto. Formato EE.UU. con punto decimal (ej. "1234.56"), sin símbolo de moneda. null si no hay un total claro. Respondé SOLO con un objeto JSON {"1":"12.50","2":null}, sin explicaciones ni bloques de código.';

export interface ItemLote {
  readonly idx: number;
  readonly id: number;
  readonly texto: string;
}

export type FetchFn = typeof fetch;

/** Candidatos: OK con OCR pero sin monto (lo manual ya fijado no se toca). */
export function candidatos(): Comprobante[] {
  return aplanar().filter(
    (c) => c.estado === "ok" && c.montoCents === null && c.textoOcr.trim() !== "",
  );
}

/** Ruido fuera + cap por ticket (el TOTAL sobrevive; si no, queda manual). */
export function limpiarTexto(s: string): string {
  return sanear(s).replace(/\s+/g, " ").trim().slice(0, MAX_TEXTO);
}

/** Ids cortos 1..N (nunca nombres de archivo: ahorra tokens y no rompe el parser). */
export function construirPrompt(items: readonly Pick<ItemLote, "idx" | "texto">[]): string {
  return `${SISTEMA}\n\n${items.map((it) => `[#${it.idx}]\n${it.texto}`).join("\n\n")}`;
}

// ponytail: chunks secuenciales por presupuesto de contexto, no 1 llamada por ticket.
export function partirLote(items: readonly ItemLote[]): ItemLote[][] {
  const lotes: ItemLote[][] = [];
  let actual: ItemLote[] = [];
  let chars = 0;
  for (const it of items) {
    if (
      actual.length >= MAX_ITEMS_LLAMADA ||
      (actual.length > 0 && chars + it.texto.length > MAX_CHARS_LOTE)
    ) {
      lotes.push(actual);
      actual = [];
      chars = 0;
    }
    actual.push(it);
    chars += it.texto.length;
  }
  if (actual.length > 0) lotes.push(actual);
  return lotes;
}

/** JSON tolerante (directo → fence ```json → primer {...}); nunca lanza. */
export function extraerJsonContenido(contenido: string): Record<string, unknown> | null {
  const intentar = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return typeof v === "object" && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const directo = intentar(contenido.trim());
  if (directo) return directo;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(contenido)?.[1];
  if (fence) {
    const f = intentar(fence.trim());
    if (f) return f;
  }
  const ini = contenido.indexOf("{");
  const fin = contenido.lastIndexOf("}");
  if (ini >= 0 && fin > ini) return intentar(contenido.slice(ini, fin + 1));
  return null;
}

/** Un chunk → mapa idx→cents (null = manual). Lanza solo si la red/HTTP falla. */
export async function extraerTotalesLote(
  items: readonly ItemLote[],
  config: ConfigIA,
  fetchFn: FetchFn = fetch,
): Promise<Map<number, Cents | null>> {
  const salida = new Map<number, Cents | null>(items.map((it) => [it.idx, null]));
  if (items.length === 0) return salida;
  const res = await fetchFn(config.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 1000,
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: construirPrompt(items) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data: unknown = await res.json().catch((): null => null);
  if (typeof data !== "object" || data === null) return salida;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return salida;
  const primero: unknown = choices[0];
  if (typeof primero !== "object" || primero === null) return salida;
  const message = (primero as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return salida;
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") return salida;
  const obj = extraerJsonContenido(content);
  if (!obj) return salida;
  for (const it of items) {
    const raw = obj[String(it.idx)];
    if (raw === null || raw === undefined) continue;
    salida.set(it.idx, parsearMonto(String(raw))); // inválido → null (manual)
  }
  return salida;
}

/** Aplica montos solo a comprobantes vivos que sigan en null. Devuelve aplicados. */
export function aplicarTotales(
  items: readonly ItemLote[],
  montos: ReadonlyMap<number, Cents | null>,
): number {
  let aplicados = 0;
  for (const it of items) {
    const cents = montos.get(it.idx) ?? null;
    if (cents === null) continue;
    const slot = buscarSlot(it.id);
    if (!slot) continue; // limpiado/quitado durante el fetch: no resucita
    const actual = slot.hoja.slots[slot.idx];
    if (!actual || actual.montoCents !== null) continue; // manual ganó durante el fetch
    actual.montoCents = cents;
    aplicados++;
  }
  return aplicados;
}

let extrayendo = false;

export function estaExtrayendo(): boolean {
  return extrayendo;
}

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

function refrescarBoton(): void {
  const btn = document.getElementById("btnIA");
  if (btn instanceof HTMLButtonElement) btn.disabled = extrayendo;
}

/** Orquestador: nunca lanza; sin key o sin pendientes sale en silencio (salvo forzado). */
export async function extraerPendientes(opciones?: {
  forzado?: boolean;
  desdeCola?: boolean;
}): Promise<void> {
  if (extrayendo) return;
  // ponytail: la cola es continuación secuencial del mismo trabajo (no concurrencia),
  // por eso solo ella salta este guard con desdeCola.
  if (state.colaEnProceso && !opciones?.desdeCola) {
    if (opciones?.forzado) avisar("OCR en curso: la IA corre sola al terminar.");
    return;
  }
  const lista = candidatos();
  if (lista.length === 0) {
    if (opciones?.forzado) avisar("IA: sin pendientes (todo ya tiene total o es manual).");
    return;
  }
  if (state.configIA.apiKey.trim() === "") {
    if (opciones?.forzado) avisar("IA: configurá la API key en Ajustes.");
    return;
  }
  const items: ItemLote[] = [];
  lista.forEach((c, i) => {
    const texto = limpiarTexto(c.textoOcr);
    if (texto !== "") items.push({ idx: i + 1, id: c.id, texto });
  });
  if (items.length === 0) return;
  extrayendo = true;
  refrescarBoton();
  try {
    let ok = 0;
    // ponytail: secuencial, no paralelo (una key, un rate-limit).
    for (const chunk of partirLote(items)) {
      try {
        ok += aplicarTotales(chunk, await extraerTotalesLote(chunk, state.configIA));
      } catch {
        continue; // el chunk queda manual; el conteo final lo refleja
      }
    }
    if (ok > 0) renderHojas(); // badges + #montoTotal con suma local exacta
    avisar(
      ok === items.length
        ? `IA: ${ok}/${items.length} totales.`
        : `IA: ${ok}/${items.length} totales, resto manual.`,
    );
  } finally {
    extrayendo = false;
    refrescarBoton();
  }
}
