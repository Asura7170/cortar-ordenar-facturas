/* Botón GitHub: pinta el conteo de estrellas en vivo (fallback estático). */
import { getEl } from "../utils";

const URL_REPO = "https://api.github.com/repos/Asura7170/cortar-ordenar-facturas";

const estrellas: HTMLElement = getEl("githubStars");

// ponytail: un fetch al arrancar, sin reintentos ni caché; si falla, el enlace estático basta.
export async function initGithub(): Promise<void> {
  try {
    const res = await fetch(URL_REPO);
    if (!res.ok) return;
    const datos: unknown = await res.json();
    if (typeof datos !== "object" || datos === null || !("stargazers_count" in datos)) return;
    const n: unknown = datos.stargazers_count;
    if (typeof n !== "number") return;
    estrellas.textContent = String(n);
  } catch {
    /* offline/rate-limit: el botón estático sigue valiendo */
  }
}
