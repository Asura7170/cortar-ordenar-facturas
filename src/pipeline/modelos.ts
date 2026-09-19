/* Modelos LLM: normaliza base chat/responses y lista /models (convención OpenAI). */
import type { FetchFn } from "./extract";

export type TipoEndpoint = "chat" | "responses";

/** chat por defecto; solo /responses explícito usa Responses. */
export function detectarTipo(baseUrl: string): TipoEndpoint {
  return baseUrl.trim().replace(/\/+$/, "").endsWith("/responses") ? "responses" : "chat";
}

/** Recorta /chat/completions o /responses y añade /models. */
export function urlListaModelos(baseUrl: string): string {
  return (
    baseUrl
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/(chat\/completions|responses)$/, "") + "/models"
  );
}

/** `{data:[{id}]}` o `string[]`; resto → []. */
export function extraerIdsModelos(json: unknown): string[] {
  const ids: string[] = [];
  const empujar = (v: unknown): void => {
    if (typeof v === "string" && v.trim() !== "" && !ids.includes(v)) ids.push(v);
  };
  if (Array.isArray(json)) {
    json.forEach(empujar);
    return ids;
  }
  if (typeof json === "object" && json !== null) {
    const data = (json as { data?: unknown }).data;
    if (Array.isArray(data)) for (const it of data) empujar((it as { id?: unknown })?.id);
  }
  return ids;
}

export const TIMEOUT_MODELOS_MS = 15_000;

/* Lista pública https://opencode.ai/zen/go/v1/models (sin key) del 2026-09-19.
   El GET no trae ACAO y el navegador lo bloquea: se vendorea para elegir sin red. */
// ponytail: snapshot, no live; refrescar con curl a /zen/go/v1/models si queda vieja.
export const MODELOS_ZEN_GO: readonly string[] = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "longcat-2.0",
  "kimi-k2.5",
  "glm-5.2",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.1",
  "glm-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "qwen3.7-max",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "hy4-preview",
  "hy3",
  "hy3-preview",
  "gpt-5.6-luna",
  "grok-4.5",
  "grok-4.6",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "omen-alpha",
];

/** True si la URL es zen (directa o vía proxy dev). */
export function esZen(url: string): boolean {
  return url.includes("opencode.ai/zen") || url.startsWith("/zen-go");
}

const LS_SESION_IA = "libro-mayor-sesion-ia";

/** Id estable por navegador para x-opencode-session (zen/go lo exige). Nunca lanza. */
export function sesionIA(): string {
  try {
    const previa = localStorage.getItem(LS_SESION_IA);
    if (typeof previa === "string" && previa.trim() !== "") return previa;
  } catch {
    /* sin almacenamiento: genera efímera */
  }
  const nuevo =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sesion-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
  try {
    localStorage.setItem(LS_SESION_IA, nuevo);
  } catch {
    /* sin almacenamiento: se usa igual */
  }
  return nuevo;
}

/** Mensaje del proveedor (`{error:{message}}` o `{error:"…"}`), recortado. */
function mensajeProveedor(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const err = (json as { error?: unknown }).error;
  const m = typeof err === "object" && err !== null ? (err as { message?: unknown }).message : err;
  return typeof m === "string" ? m.trim().slice(0, 160) : "";
}
/** Sugerencias sin red solo para zen (el resto sigue con /models en vivo). */
export function sugeridosZenGo(baseUrl: string): string[] {
  return baseUrl.includes("opencode.ai/zen") ? [...MODELOS_ZEN_GO] : [];
}

/** Proxy dev mismo-origen: las rutas zen no responden OPTIONS (preflight 404).
    Solo en dev/preview con proxy; en dist estático va directo y rige el fallback. */
export function urlProxy(url: string): string {
  if (!import.meta.env.DEV) return url;
  const marca = "/zen/go";
  const i = url.indexOf(marca);
  return i < 0 ? url : `/zen-go${url.slice(i + marca.length)}`;
}

/** GET {base}/models con Bearer; lanza si red/HTTP falla. */
export async function listarModelos(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MODELOS_MS);
  try {
    const destino = urlProxy(urlListaModelos(baseUrl));
    const res = await fetchFn(destino, {
      headers: {
        ...(esZen(destino) ? { "x-opencode-session": sesionIA() } : {}),
        Authorization: `Bearer ${apiKey}`,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Modelos ${res.status}`);
    return extraerIdsModelos(await res.json().catch((): null => null));
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith("Modelos ")) throw e;
    if (e instanceof DOMException && e.name === "AbortError")
      throw new Error("Modelos timeout (15s)", { cause: e });
    if (e instanceof TypeError)
      throw new Error(
        "Modelos CORS/red: respuesta bloqueada (el GET no trae access-control-allow-origin)",
        { cause: e },
      );
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export interface PruebaOk {
  readonly ok: true;
  readonly tipo: TipoEndpoint;
  readonly ms: number;
}

export interface PruebaError {
  readonly ok: false;
  readonly tipo: TipoEndpoint;
  readonly mensaje: string;
}

export type PruebaConexion = PruebaOk | PruebaError;

/** POST mínimo (1 token) para verificar endpoint+key+modelo. Nunca lanza. */
export async function probarConexion(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchFn: FetchFn = fetch,
): Promise<PruebaConexion> {
  const tipo = detectarTipo(baseUrl);
  const cuerpo =
    tipo === "responses"
      ? { model, input: "ping", temperature: 0, max_output_tokens: 5 }
      : {
          model,
          temperature: 0,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MODELOS_MS);
  const ini = performance.now();
  try {
    const destino = urlProxy(baseUrl);
    const res = await fetchFn(destino, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(esZen(destino) ? { "x-opencode-session": sesionIA() } : {}),
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(cuerpo),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let prov = "";
      try {
        prov = mensajeProveedor(await res.json());
      } catch {
        prov = "";
      }
      const detalle = prov !== "" ? `: ${prov}` : "";
      if (res.status === 401)
        return { ok: false, tipo, mensaje: `clave inválida o ausente (401)${detalle}` };
      if (res.status === 404)
        return { ok: false, tipo, mensaje: `URL no existe (404): revisá la Base URL${detalle}` };
      if (res.status === 429)
        return { ok: false, tipo, mensaje: `límite excedido (429)${detalle}` };
      return { ok: false, tipo, mensaje: `LLM ${res.status}${detalle}` };
    }
    return { ok: true, tipo, ms: Math.round(performance.now() - ini) };
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError")
      return { ok: false, tipo, mensaje: "timeout (15s)" };
    if (e instanceof TypeError)
      return {
        ok: false,
        tipo,
        mensaje:
          "CORS/red: el servidor no responde a navegador (zen/go no trae access-control-allow-origin); verificá con curl",
      };
    return { ok: false, tipo, mensaje: e instanceof Error ? e.message : "error" };
  } finally {
    clearTimeout(t);
  }
}
