/* Recorte manual por comprobante: modal con la imagen fija en el canvas base
   y 8 tiradores (4 lados + 4 esquinas) sobre el overlay. Confirmar commitea
   el recorte como JPEG y relee el OCR (igual que el giro). Estado efímero. */
import { buscarSlot, obtenerComprobante, state } from "../state";
import { asignarMiniatura, generarMiniatura } from "../pipeline/queue";
import { releerTrasEdicion, cancelarRelecturaProgramada } from "../pipeline/rotar";
import { CALIDAD_JPEG, cargarReal, crearReal } from "../pipeline/imagen";
import type { DepsOcr } from "../pipeline/ocr";
import { getEl } from "../utils";

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

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

/** Abre el editor para el comprobante (no-op fuera de ok o sin bitmap). */
/** Apertura en curso: dos clics rápidos pasarían el guard modal.open (falso
    hasta el showModal) y el segundo mataría el bitmap del primero. */
let aperturaEnCurso = false;

export async function abrirRecorte(id: number, deps?: DepsOcr): Promise<void> {
  if (modal.open || aperturaEnCurso) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  const cargar = deps?.cargar ?? cargarReal;
  aperturaEnCurso = true;
  let foto: ImageBitmap;
  try {
    // ponytail: el editor abre el intake pre-warp (recupera lo cortado de más);
    // sin previo (DocAligner no-op), la imagen actual.
    const fuente = item.previoDocAligner ?? item.file ?? (await (await fetch(item.imgUrl)).blob());
    foto = await cargar(fuente);
  } catch {
    avisar("No se pudo abrir el recorte.");
    return;
  } finally {
    aperturaEnCurso = false;
  }
  if (foto.width < 2 || foto.height < 2) {
    foto.close();
    return;
  }
  // ponytail: el decode tarda (~100ms): si el item se fue en la ventana, no
  // se abre un editor fantasma (igual que cola/rotar re-chequean al dueño).
  const vigente = obtenerComprobante(id);
  if (!vigente || vigente.estado !== "ok" || !buscarSlot(id)) {
    foto.close();
    return;
  }
  cerrarAnterior();
  idAbierto = id;
  bmp = foto;
  depsVigentes = deps;
  modal.showModal();
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
  const ctxBase = base.getContext("2d");
  if (!ctxBase) {
    cerrarAnterior();
    modal.close();
    avisar("No se pudo abrir el recorte.");
    return;
  }
  ctxBase.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctxBase.imageSmoothingQuality = "high";
  ctxBase.drawImage(foto, MARGEN, MARGEN, cw, ch);
  restablecer();
}

function restablecer(): void {
  rect = { x: MARGEN, y: MARGEN, w: cw, h: ch };
  activo = 7;
  dibujarGuia();
}

function cerrarAnterior(): void {
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

/** Borde bajo el punto: tirador cercano, o la línea más próxima en banda. */
function bordeEn(p: { x: number; y: number }): Borde | null {
  const i = tiradorEn(p);
  if (i >= 0) return TIRADORES[i]?.b ?? null;
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
  const dN = Math.abs(p.y - arr);
  const dS = Math.abs(p.y - aba);
  const dO = Math.abs(p.x - izq);
  const dE = Math.abs(p.x - der);
  const d = Math.min(dN, dS, dO, dE);
  if (d > BANDA_BORDE) return null;
  // Cerca de un vértice manda la esquina (coherente con el radio generoso).
  if (d === dN) return p.x < izq + RADIO_ESQUINA ? "no" : p.x > der - RADIO_ESQUINA ? "ne" : "n";
  if (d === dS) return p.x < izq + RADIO_ESQUINA ? "so" : p.x > der - RADIO_ESQUINA ? "se" : "s";
  if (d === dO) return p.y < arr + RADIO_ESQUINA ? "no" : p.y > aba - RADIO_ESQUINA ? "so" : "o";
  return p.y < arr + RADIO_ESQUINA ? "ne" : p.y > aba - RADIO_ESQUINA ? "se" : "e";
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
  if (b === "n" || b === "ne" || b === "no") arr = Math.min(Math.max(p.y, MARGEN), aba0 - minLado);
  if (b === "s" || b === "se" || b === "so") aba = Math.max(Math.min(p.y, abaMax), arr + minLado);
  if (b === "o" || b === "no" || b === "so") izq = Math.min(Math.max(p.x, MARGEN), der0 - minLado);
  if (b === "e" || b === "ne" || b === "se") der = Math.max(Math.min(p.x, derMax), izq + minLado);
  rect = { x: izq, y: arr, w: der - izq, h: aba - arr };
  pedirGuia();
}

/** Confirma: recorta en píxeles naturales, commitea y relee el OCR. Nunca lanza. */
let confirmando = false; // anti doble-clic/Enter (dos commits solapados revocaban URLs vivas)
async function confirmar(): Promise<void> {
  const id = idAbierto;
  const foto = bmp;
  if (id === null || !foto || confirmando) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  const crear = depsVigentes?.crear ?? crearReal;
  confirmando = true;
  try {
    const sx = Math.min(Math.round((rect.x - MARGEN) * escala), foto.width - 1);
    const sy = Math.min(Math.round((rect.y - MARGEN) * escala), foto.height - 1);
    const w = Math.min(Math.round(rect.w * escala), foto.width - sx);
    const h = Math.min(Math.round(rect.h * escala), foto.height - sy);
    if (w < MIN_NATURAL || h < MIN_NATURAL) {
      avisar("El recorte es demasiado pequeño.");
      return;
    }
    const lienzo = crear();
    lienzo.width = w;
    lienzo.height = h;
    const ctx = lienzo.getContext("2d");
    if (!ctx) throw new Error("sin contexto 2d");
    ctx.drawImage(foto, sx, sy, w, h, 0, 0, w, h);
    const recortado = await new Promise<Blob | null>((res) =>
      lienzo.toBlob(res, "image/jpeg", CALIDAD_JPEG),
    );
    if (!recortado) throw new Error("sin blob recortado");
    // ponytail: commit tras los awaits (igual que la cola: sin dueño no se
    // guarda). Sin dueño o descarte en vuelo se cierra (el evento close limpia
    // el bitmap rancio).
    if (idAbierto !== id || !buscarSlot(id)) {
      modal.close();
      return;
    }
    const thumb = await generarMiniatura(recortado);
    // ponytail: commit atómico (giro en vuelo: mutar partido mezclaba imágenes).
    // Sin dueño o descarte en vuelo se cierra y la thumb huérfana se revoca.
    if (idAbierto !== id || !buscarSlot(id)) {
      if (thumb) URL.revokeObjectURL(thumb);
      modal.close();
      return;
    }
    URL.revokeObjectURL(item.imgUrl);
    item.imgUrl = URL.createObjectURL(recortado);
    item.file = recortado;
    // ponytail: el previo se conserva (cada sesión parte de la imagen más
    // ancha: así un sobre-recorte siempre se puede rectificar ensanchando).
    if (thumb) asignarMiniatura(item, thumb);
    // ponytail: sin thumb se muestra el recorte nuevo (alias revocado o esqueleto mienten).
    else item.thumbUrl = item.imgUrl;
    // ponytail: import antes del close (si falla, el catch dice la verdad:
    // nada se commiteó todavía).
    const { renderHojas } = await import("./sheets");
    modal.close();
    renderHojas();
    // ponytail: el giro programa su relectura con debounce (si el recorte
    // llega antes, el timer rancio la pisaría después con texto viejo).
    cancelarRelecturaProgramada(id);
    void releerTrasEdicion(id, recortado, depsVigentes);
  } catch {
    avisar("No se pudo recortar la imagen.");
  } finally {
    confirmando = false;
  }
}

export function initRecorte(): void {
  // ponytail: guard anti doble-cableado (HMR/tests llaman más de una vez).
  if (modal.dataset["init"] === "1") return;
  modal.dataset["init"] = "1";

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
    const b = bordeEn(p);
    if (b) guia.style.cursor = TIRADORES.find((t) => t.b === b)?.cursor ?? "default";
    else guia.style.cursor = dentroDe(p) ? "move" : "default";
  });
  const soltar = (): void => {
    enArrastre = false;
    moviendoEntero = false;
  };
  guia.addEventListener("pointerup", soltar);
  guia.addEventListener("pointercancel", soltar);

  // Teclado: [ ] rotan el tirador activo, flechas lo mueven, Enter confirma.
  // Tab queda libre: el orden nativo del <dialog> alcanza barra y cerrar.
  guia.addEventListener("keydown", (e) => {
    if (!bmp) return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      activo = (activo + (e.key === "[" ? TIRADORES.length - 1 : 1)) % TIRADORES.length;
      borde = TIRADORES[activo]?.b ?? borde;
      dibujarGuia();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void confirmar();
      return;
    }
    const paso = (e.shiftKey ? 5 : 1) * PASO_TECLA;
    const t = TIRADORES[activo];
    if (!t) return;
    const hx = rect.x + rect.w * t.fx;
    const hy = rect.y + rect.h * t.fy;
    const d =
      e.key === "ArrowUp"
        ? { x: hx, y: hy - paso }
        : e.key === "ArrowDown"
          ? { x: hx, y: hy + paso }
          : e.key === "ArrowLeft"
            ? { x: hx - paso, y: hy }
            : e.key === "ArrowRight"
              ? { x: hx + paso, y: hy }
              : null;
    if (!d) return;
    e.preventDefault();
    moverA(t.b, d);
  });
}
