/* Utilidades compartidas (hojas del grafo: sin dependencias internas). */

/** getElementById que falla fuerte si falta el id (el HTML es contrato). */
export function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Falta #${id} en index.html`);
  return el as T;
}

/** Sanea entrada del usuario (nombres de archivo, texto OCR) antes del DOM. */
export function sanear(s: unknown): string {
  // ponytail: solo string/number llegan al DOM; objetos → "" (nunca "[object Object]").
  return (typeof s === "string" ? s : typeof s === "number" ? String(s) : "").toWellFormed();
}

/* Canal global de avisos (#aviso): pila de toasts fijos abajo-derecha. Cada
   mensaje entra apilándose (desde debajo del borde, keyframe toast-subir); se
   cierra con su X, expira solo (aviso 5s, error 8s; el hover pausa el timer)
   y sale desvaneciéndose. Los de intake los limpia el éxito del lote. */

/** Duración del auto-cierre (ms): el error da más margen de lectura. */
const DURACION_AUTO = { error: 8000, aviso: 5000 } as const;
/** Tope del stack: 3 toasts de archivo + 1 de resumen, nada invade el canvas. */
export const MAX_TOASTS = 4;
/** Vida de la animación de salida (ms): al terminar, el nodo se retira. Timer
    determinista: jsdom no computa transiciones y Chrome apaga el fade con el
    movimiento reducido global; el nodo siempre se retira. */
const SALIDA_MS = 340;

/** Mensaje de toast: causa corta (título), acción y archivo (detalle). */
export interface ToastMensaje {
  readonly tipo: "error" | "aviso";
  readonly titulo: string;
  readonly detalle?: string;
  readonly archivo?: string;
  /** Los rechazos del intake se limpian al éxito del lote (despejarToasts). */
  readonly grupo?: "intake";
}

/** Timers del auto-cierre por toast (el hover los pausa). */
const cierreEn = new WeakMap<HTMLElement, number>();

/** Retira el nodo tras el fade; idempotente (X doble no rompe ni duplica).
    El reemplazo de singleton (instantáneo) no pasa por el fade: un swap no
    debe verse como dos toasts. */
function cerrarToast(toast: HTMLElement, instantaneo = false): void {
  const timer = cierreEn.get(toast);
  if (timer !== undefined) {
    clearTimeout(timer);
    cierreEn.delete(toast);
  }
  if (toast.classList.contains("saliendo")) {
    if (instantaneo) toast.remove();
    return;
  }
  if (instantaneo) {
    toast.remove();
    return;
  }
  toast.classList.add("saliendo");
  window.setTimeout((): void => toast.remove(), SALIDA_MS);
}

/** Programa el auto-cierre según el tipo del toast (el hover lo pausa). */
function programar(toast: HTMLElement): void {
  const previo = cierreEn.get(toast);
  if (previo !== undefined) clearTimeout(previo);
  const dur = toast.dataset.tipo === "error" ? DURACION_AUTO.error : DURACION_AUTO.aviso;
  cierreEn.set(
    toast,
    window.setTimeout((): void => cerrarToast(toast), dur),
  );
}

/** Cierra (con fade) todos los toasts que matcheen el selector. */
function cerrarPorSelector(el: ParentNode, selector: string): void {
  for (const toast of el.querySelectorAll<HTMLElement>(selector)) cerrarToast(toast);
}

/** Singleton (conteos, fallos sueltos sin archivo): reemplaza al general
    previo en el acto (sin fade: un swap no se lee como dos toasts). */
function despejarGenerales(el: HTMLElement): void {
  for (const toast of el.querySelectorAll<HTMLElement>(".toast:not([data-grupo])")) {
    cerrarToast(toast, true);
  }
}

/** Al éxito del lote, los rechazos viejos de entrada mueren (con fade) para
    que no se confundan con el nuevo intento. */
export function despejarToasts(grupo: "intake"): void {
  const el = document.getElementById("aviso");
  if (!el) return;
  cerrarPorSelector(el, `.toast[data-grupo="${grupo}"]:not(.saliendo)`);
}

/** Cap por write: 3 toasts de archivo + 1 resumen «…y N más descartados»
    (puro, sin sobre-textuar: no desglosa motivos). Puro. */
export function planificarToasts(items: readonly ToastMensaje[]): readonly ToastMensaje[] {
  if (items.length <= MAX_TOASTS) return items;
  const resumen: ToastMensaje =
    items[0]?.grupo === "intake"
      ? { tipo: "error", titulo: `…y ${items.length - 3} más descartados`, grupo: "intake" }
      : { tipo: "error", titulo: `…y ${items.length - 3} más descartados` };
  return [...items.slice(0, 3), resumen];
}

/** Botón × del toast: sin texto en el DOM (la cruz la dibuja el ::before del
    CSS — el textContent del toast queda limpio para el test del contrato);
    nombre accesible vía aria-label e hit 44px por el ::after. */
function botonCerrar(toast: HTMLElement): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "toast-cerrar";
  b.setAttribute("aria-label", "Cerrar aviso");
  b.addEventListener("click", () => cerrarToast(toast));
  return b;
}

/** Arma el nodo del toast: alert (assertivo) para errores, status para avisos. */
function crearToast(m: ToastMensaje): HTMLDivElement {
  const toast = document.createElement("div");
  toast.className = `toast toast-${m.tipo}`;
  toast.setAttribute("role", m.tipo === "error" ? "alert" : "status");
  toast.dataset.tipo = m.tipo;
  if (m.grupo) toast.dataset.grupo = m.grupo;

  const cuerpo = document.createElement("div");
  cuerpo.className = "toast-cuerpo";
  const titulo = document.createElement("p");
  titulo.className = "toast-titulo";
  titulo.textContent = sanear(m.titulo);
  cuerpo.append(titulo);
  if (m.detalle !== undefined || m.archivo !== undefined) {
    const detalle = document.createElement("p");
    detalle.className = "toast-detalle";
    if (m.detalle) detalle.append(document.createTextNode(sanear(m.detalle)));
    if (m.archivo) {
      if (m.detalle) detalle.append(document.createTextNode(" · "));
      const archivo = document.createElement("span");
      archivo.className = "toast-archivo";
      archivo.textContent = sanear(m.archivo);
      archivo.title = sanear(m.archivo); // completo: el ellipsis nunca esconde el valor
      detalle.append(archivo);
    }
    cuerpo.append(detalle);
  }
  toast.append(cuerpo, botonCerrar(toast));
  // Hover pausa el auto-cierre (retoma al salir): mensaje que desaparece
  // mientras se lee no se lee.
  toast.addEventListener("mouseenter", () => {
    const timer = cierreEn.get(toast);
    if (timer !== undefined) clearTimeout(timer);
  });
  toast.addEventListener("mouseleave", (): void => programar(toast));
  return toast;
}

/** Apila un toast: singleton si no lleva grupo; respeta el cap del stack. */
function apilarToast(el: HTMLElement, m: ToastMensaje): void {
  if (m.grupo === undefined) despejarGenerales(el);
  const vivos = (): NodeListOf<HTMLElement> => el.querySelectorAll(".toast:not(.saliendo)");
  while (vivos().length >= MAX_TOASTS) {
    const primero = vivos()[0];
    if (!primero) break;
    cerrarToast(primero); // el más viejo hace lugar (con fade)
  }
  const toast = crearToast(m);
  programar(toast);
  el.append(toast); // al final: el nuevo queda pegado a la esquina (abajo)
}

/** Apila un lote de mensajos (respeta el cap: el más viejo sale primero). */
export function mostrarToasts(items: readonly ToastMensaje[]): void {
  const el = document.getElementById("aviso");
  if (!el) return;
  for (const m of planificarToasts(items)) apilarToast(el, m);
}

/** Toast de error (rojo, alert). Sin #aviso, no-op. */
export function avisarError(texto: string): void {
  mostrarToasts([{ tipo: "error", titulo: texto }]);
}

/** Toast de aviso, no-error (amarillo, status): conteos del lote, OCR en curso. */
export function avisar(texto: string): void {
  mostrarToasts([{ tipo: "aviso", titulo: texto }]);
}

/** Detecta el fallo de un import dinámico de chunk muerto (pestaña viva que
    cruza un deploy: el asset hashado viejo ya no existe → 404). Chrome:
    "Failed to fetch dynamically imported module: <url>" y viejo
    "Importing a module script failed". */
export function esImportDinamicoMuerto(mensaje: string): boolean {
  return /dynamically imported|importing a module|dynamic import/i.test(mensaje);
}
