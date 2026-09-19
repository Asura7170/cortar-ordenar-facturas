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

/** GET {base}/models con Bearer; lanza si red/HTTP falla. */
export async function listarModelos(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MODELOS_MS);
  try {
    const res = await fetchFn(urlListaModelos(baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Modelos ${res.status}`);
    return extraerIdsModelos(await res.json().catch((): null => null));
  } finally {
    clearTimeout(t);
  }
}
