/* Proxy Pages /api/jev → TypeSafe System One.
   Sin esto Pages responde 405 a POST en ruta estática (ver HAR prod).
   Solo POST + OPTIONS; reenvía Authorization y propaga retry-after. Sin logs. */
const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 14_000;

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", Vary: "Origin" };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  const auth = request.headers.get("Authorization");
  if (!auth) return new Response("Falta Authorization", { status: 401, headers: cors });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // ponytail: buffer en memoria — el body ya viene topado (≤1800 chars); evita duplex:half.
    const cuerpo = await request.arrayBuffer();
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") ?? "application/json",
        Authorization: auth,
      },
      body: cuerpo,
      signal: ctrl.signal,
    });
    const salida = new Headers(cors);
    const ct = res.headers.get("Content-Type");
    if (ct) salida.set("Content-Type", ct);
    const ra = res.headers.get("retry-after");
    if (ra) salida.set("retry-after", ra);
    return new Response(await res.arrayBuffer(), { status: res.status, headers: salida });
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError")
      return new Response("timeout upstream", { status: 504, headers: cors });
    return new Response("proxy caído", { status: 502, headers: cors });
  } finally {
    clearTimeout(t);
  }
}
