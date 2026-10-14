/* Recorte manual por comprobante: modal con la imagen fija en el canvas base
   y 8 tiradores (4 lados + 4 esquinas) sobre el overlay. Confirmar commitea
   el recorte como WebP y relee el OCR (igual que el giro). Estado efímero. */
import { buscarSlot, obtenerComprobante, state } from "../state";
import { releerTrasEdicion, cancelarRelecturaProgramada } from "../pipeline/rotar";
import { CALIDAD_WEBP, cargarReal, crearReal } from "../pipeline/imagen";
import type { DepsOcr } from "../pipeline/ocr";
import type { Comprobante } from "../types";
import { avisarError, getEl } from "../utils";

const modal: HTMLDialogElement = getEl<HTMLDialogElement>("modalRecorte");
const base: HTMLCanvasElement = getEl<HTMLCanvasElement>("recorteBase");
const guia: HTMLCanvasElement = getEl<HTMLCanvasElement>("recorteGuia");
const btnOk: HTMLButtonElement = getEl<HTMLButtonElement>("btnRecorteOk");
const btnReset: HTMLButtonElement = getEl<HTMLButtonElement>("btnRecorteReset");

type Borde = "n" | "s" | "e" | "o" | "ne" | "no" | "se" | "so";

interface Tirador {
  readonly b: Borde;
  readonly fx: number;
  readonly fy: number;
  readonly cursor: string;
}

const TIRADORES: readonly Tirador[] = [
  { b: "n", fx: 0.5, fy: 0, cursor: "ns-resize" },
  { b: "s", fx: 0.5, fy: 1, cursor: "ns-resize" },
  { b: "e", fx: 1, fy: 0.5, cursor: "ew-resize" },
  { b: "o", fx: 0, fy: 0.5, cursor: "ew-resize" },
  { b: "ne", fx: 1, fy: 0, cursor: "nesw-resize" },
  { b: "so", fx: 0, fy: 1, cursor: "nesw-resize" },
  { b: "no", fx: 0, fy: 0, cursor: "nwse-resize" },
  { b: "se", fx: 1, fy: 1, cursor: "nwse-resize" },
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RADIO_ESQUINA = 32; // esquinas generosas (manos mayores, táctil)
const RADIO_LADO = 26;
const BANDA_BORDE = 14; // agarre en plena línea, lejos de tiradores
const LADO_VISUAL = 10;
const MIN_LADO = 24; // lado mínimo en px display (el natural se valida al confirmar)
const MIN_NATURAL = 8; // lado mínimo en px naturales al confirmar
const PASO_TECLA = 2;
/** Marco alrededor de la foto: aire para los tiradores del borde. */
const MARGEN = 6;

let idAbierto: number | null = null;
let sesion = 0; // token anti sesión cruzada: cerrar+reabrir invalida confirms en vuelo
let bmp: ImageBitmap | null = null;
let escala = 1; // px naturales por px display
let cw = 0;
let ch = 0;
let rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
let activo = 7; // índice del tirador activo (empieza en "se")
let borde: Borde = "se"; // borde en arrastre (el agarre puede empezar en plena línea)
let moviendoEntero = false; // arrastre del área completa por su interior
let agarreX = 0; // offset puntero−origen al agarrar el interior
let agarreY = 0;
let enArrastre = false;
let raf: number | null = null;
let depsVigentes: DepsOcr | undefined;

// ponytail: delega en el helper compartido (F3) — misma firma, así los 4
// llamados quedan intactos y el error ahora sale en span.motivo (rojo sello).
function avisar(texto: string): void {
  avisarError(texto);
}

/** Abre el editor para el comprobante (no-op fuera de ok o sin bitmap). */
/** Apertura en curso: dos clics rápidos pasarían el guard modal.open (falso
    hasta el showModal) y el segundo mataría el bitmap del primero. */
let aperturaEnCurso = false;

/** El cargador del abrir o el real (todo abre por la misma puerta). */
function cargarVigente(deps: DepsOcr | undefined): typeof cargarReal {
  return deps?.cargar ?? cargarReal;
}

/** Decodifica la fuente del comprobante (pre-warp si existe) o null si falla. */
async function fotoComprobante(
  item: Comprobante,
  cargar: typeof cargarReal,
): Promise<ImageBitmap | null> {
  try {
    // ponytail: el editor abre el intake pre-warp (recupera lo cortado de más);
    // sin previo (DocAligner no-op), la imagen actual.
    const fuente = item.previoDocAligner ?? item.file ?? (await (await fetch(item.imgUrl)).blob());
    return await cargar(fuente, { imageOrientation: "from-image" });
  } catch {
    avisar("No se pudo abrir el recorte.");
    return null;
  }
}

/** La foto es tan chica que el editor no puede operar en ella. */
function esFotoInsuficiente(foto: ImageBitmap): boolean {
  return foto.width < 2 || foto.height < 2;
}

/** Re-chequeo del dueño tras el decode (la ventana es asíncrona). */
function sigueVigente(id: number): boolean {
  const vigente = obtenerComprobante(id);
  return vigente !== undefined && vigente.estado === "ok" && buscarSlot(id) !== null;
}

/** Encaja la foto en el viewport disponible y fija el tamaño de los lienzos. */
function dimensionarCanvases(foto: ImageBitmap): void {
  // La escena ya tiene layout (el dialog está abierto): llenar ampliando o reduciendo.
  // ponytail: el marco flotante se encoge al canvas (medir la escena sería
  // circular): el espacio sale del viewport, igual que maxH.
  const maxW = Math.max(200, Math.min(window.innerWidth * 0.9, 940));
  // ponytail: cabe en el viewport con la barra flotante (sin tarjeta).
  const maxH = Math.max(200, Math.min(window.innerHeight * 0.82 - 150, 640));
  const k = Math.min((maxW - MARGEN * 2) / foto.width, (maxH - MARGEN * 2) / foto.height);
  cw = Math.max(1, Math.round(foto.width * k));
  ch = Math.max(1, Math.round(foto.height * k));
  escala = foto.width / cw;
  const dpr = window.devicePixelRatio || 1;
  const anchoLienzo = cw + MARGEN * 2;
  const altoLienzo = ch + MARGEN * 2;
  for (const c of [base, guia]) {
    c.width = Math.round(anchoLienzo * dpr);
    c.height = Math.round(altoLienzo * dpr);
    c.style.width = `${anchoLienzo}px`;
    c.style.height = `${altoLienzo}px`;
  }
}

/** Pinta la foto en el canvas base; false (y cierra) si falto el contexto 2d. */
function pintarBase(foto: ImageBitmap): boolean {
  const ctxBase = base.getContext("2d");
  if (!ctxBase) {
    cerrarAnterior();
    modal.close();
    avisar("No se pudo abrir el recorte.");
    return false;
  }
  const dpr = window.devicePixelRatio || 1;
  ctxBase.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctxBase.imageSmoothingQuality = "high";
  ctxBase.drawImage(foto, MARGEN, MARGEN, cw, ch);
  return true;
}

export async function abrirRecorte(id: number, deps?: DepsOcr): Promise<void> {
  if (modal.open || aperturaEnCurso) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  aperturaEnCurso = true;
  let foto: ImageBitmap | null = null;
  try {
    foto = await fotoComprobante(item, cargarVigente(deps));
  } finally {
    aperturaEnCurso = false;
  }
  if (!foto) return;
  if (esFotoInsuficiente(foto)) {
    foto.close();
    return;
  }
  // ponytail: el decode tarda (~100ms): si el item se fue en la ventana, no
  // se abre un editor fantasma (igual que cola/rotar re-chequean al dueño).
  if (!sigueVigente(id)) {
    foto.close();
    return;
  }
  cerrarAnterior();
  idAbierto = id;
  bmp = foto;
  depsVigentes = deps;
  modal.showModal();
  dimensionarCanvases(foto);
  if (!pintarBase(foto)) return;
  restablecer();
}

function restablecer(): void {
  rect = { x: MARGEN, y: MARGEN, w: cw, h: ch };
  activo = 7;
  dibujarGuia();
}

function cerrarAnterior(): void {
  sesion++; // invalida la confirmación en vuelo (ya no es su diálogo)
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
  bmp?.close();
  bmp = null;
  idAbierto = null;
  enArrastre = false;
  moviendoEntero = false;
}

function pedirGuia(): void {
  if (raf !== null) return;
  raf = requestAnimationFrame(() => {
    raf = null;
    dibujarGuia();
  });
}

/** Solo overlay (la base es estática): velo fuera del rect + 8 tiradores. */
function dibujarGuia(): void {
  if (!bmp) return;
  const ctx = guia.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw + MARGEN * 2, ch + MARGEN * 2);
  // ponytail: el velo vive solo sobre la foto (el marco queda transparente y
  // se funde con el velo del diálogo: sin borde negro).
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(MARGEN, MARGEN, cw, rect.y - MARGEN);
  ctx.fillRect(MARGEN, rect.y + rect.h, cw, MARGEN + ch - rect.y - rect.h);
  ctx.fillRect(MARGEN, rect.y, rect.x - MARGEN, rect.h);
  ctx.fillRect(rect.x + rect.w, rect.y, MARGEN + cw - rect.x - rect.w, rect.h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  TIRADORES.forEach((t, i) => {
    const hx = rect.x + rect.w * t.fx;
    const hy = rect.y + rect.h * t.fy;
    const l = LADO_VISUAL / 2;
    ctx.fillStyle = i === activo ? "#fff" : "#1d7a3a";
    ctx.fillRect(hx - l, hy - l, LADO_VISUAL, LADO_VISUAL);
    ctx.lineWidth = 2;
    ctx.strokeStyle = i === activo ? "#1d7a3a" : "#fff";
    ctx.strokeRect(hx - l, hy - l, LADO_VISUAL, LADO_VISUAL);
  });
}

function punto(e: PointerEvent): { x: number; y: number } {
  const r = guia.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function tiradorEn(p: { x: number; y: number }): number {
  for (const [i, t] of TIRADORES.entries()) {
    const radio = t.fx !== 0.5 && t.fy !== 0.5 ? RADIO_ESQUINA : RADIO_LADO;
    const hx = rect.x + rect.w * t.fx;
    const hy = rect.y + rect.h * t.fy;
    if (Math.hypot(p.x - hx, p.y - hy) <= radio) return i;
  }
  return -1;
}

/** Esquina si el punto pega a un vértice de esa línea; el lado puro si no. */
function conVertice(
  p: number,
  ini: number,
  fin: number,
  esqIni: Borde,
  esqFin: Borde,
  lado: Borde,
): Borde {
  return p < ini + RADIO_ESQUINA ? esqIni : p > fin - RADIO_ESQUINA ? esqFin : lado;
}

/** Línea más próxima en banda, con esquinas que mandan cerca del vértice. */
function bandaGanadora(
  p: { x: number; y: number },
  izq: number,
  arr: number,
  der: number,
  aba: number,
): Borde | null {
  const dN = Math.abs(p.y - arr);
  const dS = Math.abs(p.y - aba);
  const dO = Math.abs(p.x - izq);
  const dE = Math.abs(p.x - der);
  const d = Math.min(dN, dS, dO, dE);
  if (d > BANDA_BORDE) return null;
  // Cerca de un vértice manda la esquina (coherente con el radio generoso).
  if (d === dN) return conVertice(p.x, izq, der, "no", "ne", "n");
  if (d === dS) return conVertice(p.x, izq, der, "so", "se", "s");
  if (d === dO) return conVertice(p.y, arr, aba, "no", "so", "o");
  return conVertice(p.y, arr, aba, "ne", "se", "e");
}

/** Borde bajo el punto: tirador cercano, o la línea más próxima en banda. */
function bordeEn(p: { x: number; y: number }): Borde | null {
  const i = tiradorEn(p);
  // ponytail: i viene de tiradorEn (índice válido de la tabla); sin fallback.
  if (i >= 0) return (TIRADORES[i] as Tirador).b;
  const izq = rect.x;
  const arr = rect.y;
  const der = rect.x + rect.w;
  const aba = rect.y + rect.h;
  if (
    p.x < izq - BANDA_BORDE ||
    p.x > der + BANDA_BORDE ||
    p.y < arr - BANDA_BORDE ||
    p.y > aba + BANDA_BORDE
  )
    return null;
  return bandaGanadora(p, izq, arr, der, aba);
}

/** True si el punto cae dentro del rect (para mover el área completa). */
function dentroDe(p: { x: number; y: number }): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** Traslada el rect preservando el tamaño, siempre dentro de la foto. */
function moverEntero(p: { x: number; y: number }): void {
  rect = {
    x: Math.min(Math.max(p.x - agarreX, MARGEN), MARGEN + cw - rect.w),
    y: Math.min(Math.max(p.y - agarreY, MARGEN), MARGEN + ch - rect.h),
    w: rect.w,
    h: rect.h,
  };
  pedirGuia();
}

/** ¿Este borde arrastra el lado? (una esquina toca dos lados). */
function tocaArriba(b: Borde): boolean {
  return b === "n" || b === "ne" || b === "no";
}
function tocaAbajo(b: Borde): boolean {
  return b === "s" || b === "se" || b === "so";
}
function tocaIzquierda(b: Borde): boolean {
  return b === "o" || b === "no" || b === "so";
}
function tocaDerecha(b: Borde): boolean {
  return b === "e" || b === "ne" || b === "se";
}

/** Mueve los bordes del tirador al punto (siempre dentro de la foto). */
function moverA(b: Borde, p: { x: number; y: number }): void {
  const der0 = rect.x + rect.w;
  const aba0 = rect.y + rect.h;
  const derMax = cw + MARGEN;
  const abaMax = ch + MARGEN;
  let izq = rect.x;
  let arr = rect.y;
  let der = der0;
  let aba = aba0;
  // ponytail: mínimo en ambas unidades (con upscale, 24 display < 8 naturales).
  const minLado = Math.max(MIN_LADO, Math.ceil(MIN_NATURAL / escala));
  if (tocaArriba(b)) arr = Math.min(Math.max(p.y, MARGEN), aba0 - minLado);
  if (tocaAbajo(b)) aba = Math.max(Math.min(p.y, abaMax), arr + minLado);
  if (tocaIzquierda(b)) izq = Math.min(Math.max(p.x, MARGEN), der0 - minLado);
  if (tocaDerecha(b)) der = Math.max(Math.min(p.x, derMax), izq + minLado);
  rect = { x: izq, y: arr, w: der - izq, h: aba - arr };
  pedirGuia();
}

/** El factory vigente (el del abrir) o el real. */
function crearVigente(): typeof crearReal {
  return depsVigentes?.crear ?? crearReal;
}

/** Recorta en naturales y devuelve el blob WebP; null si era demasiado
    pequeño (avisando). Los fallos de lienzo/blob lanzan. */
async function recortarBlobDe(foto: ImageBitmap, crear: typeof crearReal): Promise<Blob | null> {
  const sx = Math.min(Math.round((rect.x - MARGEN) * escala), foto.width - 1);
  const sy = Math.min(Math.round((rect.y - MARGEN) * escala), foto.height - 1);
  const w = Math.min(Math.round(rect.w * escala), foto.width - sx);
  const h = Math.min(Math.round(rect.h * escala), foto.height - sy);
  if (w < MIN_NATURAL || h < MIN_NATURAL) {
    avisar("El recorte es demasiado pequeño.");
    return null;
  }
  const lienzo = crear();
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext("2d");
  if (!ctx) throw new Error("sin contexto 2d");
  ctx.drawImage(foto, sx, sy, w, h, 0, 0, w, h);
  const recortado = await new Promise<Blob | null>((res) =>
    lienzo.toBlob(res, "image/webp", CALIDAD_WEBP),
  );
  if (!recortado) throw new Error("sin blob recortado");
  return recortado;
}

/** Commitea el blob en el comprobante (con dueño vivo) y relee el OCR.
    False si la sesión cruzó o el dueño murió. */
async function commitearYReleer(
  item: Comprobante,
  recortado: Blob,
  id: number,
  miSesion: number,
): Promise<boolean> {
  // ponytail: sesión cruzada (cerrar+reabrir en vuelo): la confirmación vieja
  // no commitea y no toca el diálogo nuevo (sin close: ya no es suyo).
  if (sesion !== miSesion) return false;
  // ponytail: commit tras los awaits (igual que la cola: sin dueño no se
  // guarda). Sin dueño o descarte en vuelo se cierra (el evento close limpia
  // el bitmap rancio).
  if (idAbierto !== id || !buscarSlot(id)) {
    modal.close();
    return false;
  }
  URL.revokeObjectURL(item.imgUrl);
  item.imgUrl = URL.createObjectURL(recortado);
  item.file = recortado;
  // ponytail: el previo se conserva (cada sesión parte de la imagen más
  // ancha: así un sobre-recorte siempre se puede rectificar ensanchando).
  // ponytail: import antes del close (si falla, el catch dice la verdad:
  // nada se commiteó todavía). Sesión cruzada: el diálogo nuevo sigue abierto.
  const { renderHojas } = await import("./sheets");
  if (sesion !== miSesion) return false;
  modal.close();
  renderHojas();
  // ponytail: el giro programa su relectura con debounce (si el recorte
  // llega antes, el timer rancio la pisaría después con texto viejo).
  cancelarRelecturaProgramada(id);
  void releerTrasEdicion(id, recortado, depsVigentes);
  return true;
}

/** Confirma: recorta en píxeles naturales, commitea y relee el OCR. Nunca lanza. */
let confirmando = false; // anti doble-clic/Enter (dos commits solapados revocaban URLs vivas)
async function confirmar(): Promise<void> {
  const id = idAbierto;
  const foto = bmp;
  const miSesion = sesion;
  if (id === null || !foto || confirmando) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  const crear = crearVigente();
  confirmando = true;
  try {
    const recortado = await recortarBlobDe(foto, crear);
    if (!recortado) return;
    await commitearYReleer(item, recortado, id, miSesion);
  } catch {
    avisar("No se pudo recortar la imagen.");
  } finally {
    confirmando = false;
  }
}

/** Botones del modal, cierre por velo y limpieza al cerrar. */
function cablearBotonesModal(): void {
  btnOk.addEventListener("click", () => {
    void confirmar();
  });
  btnReset.addEventListener("click", () => {
    if (bmp) restablecer();
  });
  modal.addEventListener("close", () => {
    state.cierreRecorte = Date.now();
    cerrarAnterior();
  });
  // ponytail: descarte explícito (sin depender de closedby): el clic en el
  // velo tiene como target el propio dialog; el de la foto/barra, a sus hijos.
  modal.addEventListener("click", (e) => {
    if (e.target === modal && modal.open) modal.close();
  });
}

/** Arranque de arrastre: tirador o interior; captura el puntero. */
function cablearPunteroAbajo(): void {
  guia.addEventListener("pointerdown", (e) => {
    if (!bmp || !e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = punto(e);
    const b = bordeEn(p);
    e.preventDefault();
    if (!b) {
      // Interior sin borde cerca: se mueve el área completa.
      if (!dentroDe(p)) return;
      moviendoEntero = true;
      agarreX = p.x - rect.x;
      agarreY = p.y - rect.y;
    } else {
      borde = b;
      activo = Math.max(
        0,
        TIRADORES.findIndex((t) => t.b === b),
      );
      enArrastre = true;
    }
    try {
      guia.setPointerCapture(e.pointerId);
    } catch {
      /* puntero ya inactivo */
    }
    dibujarGuia();
  });
}

/** Cursor de la zona bajo el puntero: tirador, plena línea o interior. */
function cursorDeGuia(p: { x: number; y: number }): string {
  const b = bordeEn(p);
  if (b) {
    // ponytail: la tabla es exhaustiva para todo borde que devuelve bordeEn.
    return (TIRADORES.find((t) => t.b === b) as Tirador).cursor;
  }
  return dentroDe(p) ? "move" : "default";
}

/** Arrastre y cursor de la zona bajo el puntero. */
function cablearPunteroGuia(): void {
  guia.addEventListener("pointermove", (e) => {
    if (!bmp) return;
    const p = punto(e);
    if (enArrastre) {
      moverA(borde, p);
      return;
    }
    if (moviendoEntero) {
      moverEntero(p);
      return;
    }
    // ponytail: cursor de la zona bajo el puntero sin redibujar (barato).
    guia.style.cursor = cursorDeGuia(p);
  });
  const soltar = (): void => {
    enArrastre = false;
    moviendoEntero = false;
  };
  guia.addEventListener("pointerup", soltar);
  guia.addEventListener("pointercancel", soltar);
}

/** [ ] rotan el tirador activo (y su borde); false si la tecla no es esa. */
function rotarTirador(e: KeyboardEvent): boolean {
  if (e.key !== "[" && e.key !== "]") return false;
  e.preventDefault();
  activo = (activo + (e.key === "[" ? TIRADORES.length - 1 : 1)) % TIRADORES.length;
  // ponytail: activo se mantiene módulo TIRADORES.length; índice válido.
  borde = (TIRADORES[activo] as Tirador).b;
  dibujarGuia();
  return true;
}

/** Flechas: destino del tirador activo; null si la tecla no es flecha.
    Tab queda libre: el orden nativo del <dialog> alcanza barra y cerrar. */
function destinoTecla(e: KeyboardEvent, t: Tirador): { x: number; y: number } | null {
  const hx = rect.x + rect.w * t.fx;
  const hy = rect.y + rect.h * t.fy;
  const paso = (e.shiftKey ? 5 : 1) * PASO_TECLA;
  return e.key === "ArrowUp"
    ? { x: hx, y: hy - paso }
    : e.key === "ArrowDown"
      ? { x: hx, y: hy + paso }
      : e.key === "ArrowLeft"
        ? { x: hx - paso, y: hy }
        : e.key === "ArrowRight"
          ? { x: hx + paso, y: hy }
          : null;
}

/** Teclado: [ ] rotan el tirador activo, flechas lo mueven, Enter confirma. */
function cablearTecladoGuia(): void {
  guia.addEventListener("keydown", (e) => {
    if (!bmp) return;
    if (rotarTirador(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void confirmar();
      return;
    }
    // ponytail: activo se mantiene módulo TIRADORES.length; índice válido.
    const t = TIRADORES[activo] as Tirador;
    const d = destinoTecla(e, t);
    if (!d) return;
    e.preventDefault();
    moverA(t.b, d);
  });
}

export function initRecorte(): void {
  // ponytail: guard anti doble-cableado (HMR/tests llaman más de una vez).
  if (modal.dataset["init"] === "1") return;
  modal.dataset["init"] = "1";
  cablearBotonesModal();
  cablearPunteroAbajo();
  cablearPunteroGuia();
  cablearTecladoGuia();
}
