/* Extracción del TOTAL: JEV 1×1 secuencial primero, fallback openai-compatible en lote.
   Auto al drenar la cola + botón Reintentar IA. Solo completa montos en
   null no-manuales: lo manual siempre gana (incluso si se escribe durante el fetch).
   La suma total la hace el código (sumaTotal); al LLM nunca se le pide sumar. */
import { buscarSlot, state } from "../state";
import type { Cents, Comprobante, ConfigIA } from "../types";
import { aplanar, parsearMonto } from "../ui/monto";
import { actualizarMontoCelda, renderHojas } from "../ui/sheets";
import { sanear } from "../utils";
import { getJevKey, llamarJev } from "./jev";
import {
  campoRazonamiento,
  detectarTipo,
  esZen,
  sesionIA,
  sinTemperatura,
  urlProxy,
} from "./modelos";
import type { NivelRazonamiento } from "../types";

export const MAX_TEXTO = 1800;
export const MAX_CHARS_LOTE = 12000;
export const MAX_ITEMS_LLAMADA = 25;
// Sin esto un endpoint colgado deja extrayendo=true y la cola en espera eterna.
export const TIMEOUT_MS = 60_000;

const SISTEMA =
  'Eres un extractor de totales de facturas. Para cada bloque [#N] devolvé el TOTAL a pagar (total, importe total, total a pagar). Ignorá subtotal, IVA, propina y vuelto. Formato EE.UU. con punto decimal (ej. "1234.56"), sin símbolo de moneda. null si no hay un total claro. Respondé SOLO con un objeto JSON {"1":"12.50","2":null}, sin explicaciones ni bloques de código.';

export interface ItemLote {
  readonly idx: number;
  readonly id: number;
  readonly texto: string;
}

export type FetchFn = typeof fetch;

/** Candidatos: OK con OCR, sin monto y sin marca manual. */
export function candidatos(): Comprobante[] {
  return aplanar().filter(
    (c) => c.estado === "ok" && c.montoCents === null && !c.montoManual && c.textoOcr.trim() !== "",
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

/** Contenido textual: chat (`choices[0].message.content`) o responses (`output[]`). */
export function extraerContenido(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    const primero: unknown = choices[0];
    if (typeof primero === "object" && primero !== null) {
      const message = (primero as { message?: unknown }).message;
      if (typeof message === "object" && message !== null) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        // ponytail: algunos proveedores mandan content array (reasoning/vision)
        if (Array.isArray(content)) {
          const t = content
            .map((p): string => {
              if (typeof p !== "object" || p === null) return "";
              const texto = (p as { text?: unknown }).text;
              return typeof texto === "string" ? texto : "";
            })
            .join("");
          if (t !== "") return t;
        }
      }
    }
  }
  const output = (data as { output?: unknown }).output;
  if (Array.isArray(output)) {
    let texto = "";
    for (const item of output) {
      if (typeof item !== "object" || item === null) continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const parte of content) {
        if (typeof parte !== "object" || parte === null) continue;
        const t = (parte as { text?: unknown }).text;
        if (typeof t === "string") texto += t;
      }
    }
    return texto !== "" ? texto : null;
  }
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
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const tipo = detectarTipo(config.baseUrl);
    const nivel: NivelRazonamiento = config.razonamiento ?? "auto";
    const armar = (nv: NivelRazonamiento): Record<string, unknown> =>
      tipo === "responses"
        ? {
            model: config.model,
            instructions: SISTEMA,
            input: construirPrompt(items),
            ...(sinTemperatura(nv) ? {} : { temperature: 0 }),
            ...campoRazonamiento(tipo, nv),
            max_output_tokens: 8000,
          }
        : {
            model: config.model,
            ...(sinTemperatura(nv) ? {} : { temperature: 0 }),
            ...campoRazonamiento(tipo, nv),
            max_tokens: 8000,
            messages: [
              { role: "system", content: SISTEMA },
              { role: "user", content: construirPrompt(items) },
            ],
          };
    const destino = urlProxy(config.baseUrl);
    const headers = {
      "Content-Type": "application/json",
      ...(esZen(destino) ? { "x-opencode-session": sesionIA() } : {}),
      Authorization: `Bearer ${config.apiKey}`,
    };
    let res = await fetchFn(destino, {
      method: "POST",
      headers,
      body: JSON.stringify(armar(nivel)),
      signal: ctrl.signal,
    });
    // ponytail: 400 con nivel explícito → 1 reintento limpio (mismo criterio que el ping).
    if (!res.ok && res.status === 400 && nivel !== "auto") {
      res = await fetchFn(destino, {
        method: "POST",
        headers,
        body: JSON.stringify(armar("auto")),
        signal: ctrl.signal,
      });
    }
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data: unknown = await res.json().catch((): null => null);
    const content = extraerContenido(data);
    if (content === null) return salida;
    const obj = extraerJsonContenido(content);
    if (!obj) return salida;
    for (const it of items) {
      const raw = obj[String(it.idx)];
      // ponytail: solo string/number del LLM llegan a parsearMonto; objetos → null (manual).
      if (typeof raw !== "string" && typeof raw !== "number") continue;
      salida.set(it.idx, parsearMonto(String(raw))); // inválido → null (manual)
    }
    return salida;
  } finally {
    clearTimeout(t);
  }
}

/** Aplica montos solo a comprobantes vivos que sigan en null. Devuelve aplicados. */
// ponytail: el borrador en curso gana al lote en vuelo (igual que lo manual confirmado).
// Sin foco también vale: el change válido commitea en el acto, así que un input no
// vacío en celda null es borrador inválido tras blur. Sin estado extra: se lee del DOM.
function montoEnEdicion(id: number): boolean {
  const a = document.activeElement;
  if (
    a instanceof HTMLInputElement &&
    a.dataset["accion"] === "monto" &&
    a.closest(".cell")?.getAttribute("data-id") === String(id)
  )
    return true;
  const input = document.querySelector(`.cell[data-id="${id}"] input.cell-monto`);
  return input instanceof HTMLInputElement && input.value !== "";
}

export function aplicarTotales(
  items: readonly ItemLote[],
  montos: ReadonlyMap<number, Cents | null>,
): number {
  let aplicados = 0;
  for (const it of items) {
    const cents = montos.get(it.idx) ?? null;
    if (cents === null) continue;
    if (montoEnEdicion(it.id)) continue; // el borrador en curso gana al lote en vuelo
    const slot = buscarSlot(it.id);
    if (!slot) continue; // limpiado/quitado durante el fetch: no resucita
    const actual = slot.hoja.slots[slot.idx];
    if (!actual || actual.montoCents !== null) continue; // manual ganó durante el fetch
    // it.texto va limpio (limpiarTexto): se compara en el mismo espacio.
    if (limpiarTexto(actual.textoOcr) !== it.texto) continue; // girado durante el fetch: rancio
    actual.montoCents = cents;
    aplicados++;
  }
  return aplicados;
}

let extrayendo = false;

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

function refrescarBoton(): void {
  const btn = document.getElementById("btnIA");
  if (btn instanceof HTMLButtonElement) btn.disabled = extrayendo;
}

/** Ids con JEV en vuelo: evita doble fetch (1×1 desacoplado + red del drenado). */
const enVuelo = new Set<number>();

/** JEV 1×1 progresivo para la cola: resuelve un comprobante y lo pinta al
    instante, sin esperar al lote. Nunca lanza (best-effort). */
export async function extraerUnMonto(id: number, fetchFn: FetchFn = fetch): Promise<boolean> {
  if (enVuelo.has(id)) return false;
  try {
    const key = getJevKey();
    if (key === "") return false;
    const slot = buscarSlot(id);
    const actual = slot?.hoja.slots[slot.idx];
    if (!actual || actual.estado !== "ok" || actual.montoCents !== null || actual.montoManual)
      return false;
    const texto = limpiarTexto(actual.textoOcr);
    if (texto === "") return false;
    enVuelo.add(id);
    try {
      let cents: Cents | null = null;
      try {
        cents = parsearMonto((await llamarJev({ id, contenido: texto }, key, fetchFn)).total);
      } catch {
        return false; // la red del drenado lo reintenta en lote
      }
      const item: ItemLote = { idx: 1, id, texto };
      if (aplicarTotales([item], new Map([[1, cents]])) === 0) return false;
      renderHojas(); // progresivo: badge + total al instante
      return true;
    } finally {
      enVuelo.delete(id);
    }
  } catch {
    return false;
  }
}

/** Tope de vuelos JEV simultáneos por lote (TypeSafe: 1200 req/min, 250k tok/s). */
const JEV_TOPE_PARALELO = 50;

/** Pool con tope: N workers consumen índices; el worker decide errores (nunca lanza el pool). */
async function mapConLimite<T>(
  items: readonly T[],
  tope: number,
  fn: (it: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(tope, items.length));
  await Promise.all(
    Array.from({ length: n }, async (): Promise<void> => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        const it = items[k];
        if (it === undefined) return;
        await fn(it);
      }
    }),
  );
}
/** Orquestador: nunca lanza; sin key o sin pendientes sale en silencio (salvo forzado). */
export async function extraerPendientes(opciones?: {
  forzado?: boolean;
  desdeCola?: boolean;
}): Promise<void> {
  // ponytail: sin coalescing (un pedido durante el batch se pierde y su celda
  // queda manual hasta el próximo disparo; ventana rara y autorecuperable).
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
  const jevKey = getJevKey();
  const openaiKey = state.configIA.apiKey.trim();
  if (jevKey === "" && openaiKey === "") {
    if (opciones?.forzado) avisar("IA: configurá la API key en Ajustes.");
    return;
  }
  const items: ItemLote[] = [];
  lista.forEach((c, i) => {
    const texto = limpiarTexto(c.textoOcr);
    if (texto !== "") items.push({ idx: i + 1, id: c.id, texto });
  });
  if (items.length === 0) return;
  const avisoPrevio = document.getElementById("aviso")?.textContent ?? "";
  const prefijo = jevKey !== "" ? "JEV:" : "IA:";
  extrayendo = true;
  state.loteEnCurso = true; // sin VT ni rebuilds por tick (ver sheets.renderHojas)
  refrescarBoton();
  avisar(`${prefijo} extrayendo totales…`);
  try {
    let okJev = 0;
    let pendientes: ItemLote[] = items;
    if (jevKey !== "") {
      // ponytail: pool 50 (TypeSafe 1200/min, 250k tok/s): pared ~1s en vez de N×1s.
      // 1 request por factura (no mega-request: rompería state ≤32k y guards por ítem).
      // Progresivo con parche in-place: cada éxito aplica al instante y el tick
      // pinta solo su celda (sin rebuild ni VT, ver loteEnCurso); el aviso lleva
      // el conteo. El retry 429/529 corre dentro del slot.
      const cola = items.filter((it) => !enVuelo.has(it.id));
      for (const it of cola) enVuelo.add(it.id);
      // Telemetría del lote (solo DEV): pared vs percentiles por request +
      // concurrencia JS. OJO: concJS alto con waterfall de 6 en Network =
      // el navegador dosifica (límite por origen), no el servidor.
      const tLote = performance.now();
      const latencias: number[] = [];
      let enCurso = 0;
      let concMax = 0;
      const porPintar: number[] = [];
      let programado = false;
      let rendersProg = 0;
      const pintarProgreso = (): void => {
        programado = false;
        if (porPintar.length === 0) return;
        // Parche in-place por celda (sin rebuild ni VT): O(1 nodo) por éxito.
        const ids = porPintar.splice(0, porPintar.length);
        rendersProg++;
        for (const id of ids) {
          try {
            actualizarMontoCelda(id);
          } catch {
            /* el parche nunca aborta el lote */
          }
        }
        avisar(`${prefijo} ${okJev}/${items.length} totales…`);
      };
      const programaTick = (): void => {
        if (programado) return;
        programado = true;
        setTimeout(pintarProgreso, 0);
      };
      try {
        await mapConLimite(cola, JEV_TOPE_PARALELO, async (it): Promise<void> => {
          const tReq = performance.now();
          enCurso++;
          concMax = Math.max(concMax, enCurso);
          try {
            const cents = parsearMonto(
              (await llamarJev({ id: it.id, contenido: it.texto }, jevKey)).total,
            );
            if (aplicarTotales([it], new Map([[it.idx, cents]])) > 0) {
              okJev++;
              porPintar.push(it.id);
              programaTick();
            }
          } catch {
            /* este ítem cae al fallback; los hermanos siguen */
          } finally {
            latencias.push(performance.now() - tReq);
            enCurso--;
            enVuelo.delete(it.id);
          }
        });
      } finally {
        for (const it of cola) enVuelo.delete(it.id);
      }
      // Vacía el tick pendiente antes del conteo final (sin este await, el último
      // render caería después del aviso final y lo pisaría).
      await new Promise<void>((r) => {
        setTimeout(() => r(), 0);
      });
      pintarProgreso();
      if (okJev > 0) renderHojas(); // cierre: totales y consistencia en 1 rebuild
      if (import.meta.env.DEV && latencias.length > 0) {
        const ordenadas = [...latencias].sort((a, b) => a - b);
        const cuantil = (q: number): number =>
          Math.round(
            ordenadas[Math.min(ordenadas.length - 1, Math.ceil(q * ordenadas.length) - 1)] ?? 0,
          );
        const entero = (v: number): number => Math.round(v);
        console.info(
          `JEV lote ms pared=${entero(performance.now() - tLote)} n=${cola.length} ok=${okJev} ` +
            `concJS=${concMax} min=${cuantil(0)} p50=${cuantil(0.5)} p99=${cuantil(0.99)} renders=${rendersProg}`,
        );
      }
      if (okJev === items.length) {
        if (avisoPrevio.trim() === "") avisar(`${prefijo} ${okJev}/${items.length} totales.`);
        else avisar(avisoPrevio);
        return;
      }
      const restantes = candidatos();
      pendientes = [];
      restantes.forEach((c, i) => {
        if (enVuelo.has(c.id)) return; // en vuelo: lo cubre su propia promesa
        const texto = limpiarTexto(c.textoOcr);
        if (texto !== "") pendientes.push({ idx: i + 1, id: c.id, texto });
      });
      if (pendientes.length === 0) {
        if (avisoPrevio.trim() === "") avisar(`${prefijo} ${okJev}/${items.length} totales.`);
        else avisar(avisoPrevio);
        return;
      }
    }
    let okIA = 0;
    if (openaiKey !== "") {
      // ponytail: secuencial, no paralelo (una key, un rate-limit).
      for (const chunk of partirLote(pendientes)) {
        try {
          okIA += aplicarTotales(chunk, await extraerTotalesLote(chunk, state.configIA));
        } catch (e: unknown) {
          console.warn(`IA: lote omitido (${e instanceof Error ? e.message : String(e)})`);
          continue; // el chunk queda manual; el conteo final lo refleja
        }
      }
    }
    const ok = okJev + okIA;
    if (ok > 0) renderHojas(); // badges + #montoTotal con suma local exacta
    // Éxito total con aviso previo: se restaura (el interino lo pisó).
    if (ok < items.length || avisoPrevio.trim() === "") {
      avisar(
        ok === items.length
          ? `${prefijo} ${ok}/${items.length} totales.`
          : `${prefijo} ${ok}/${items.length} totales, resto manual. Revisá Ajustes (URL, clave, CORS).`,
      );
    } else {
      avisar(avisoPrevio);
    }
  } finally {
    state.loteEnCurso = false;
    extrayendo = false;
    refrescarBoton();
  }
}
