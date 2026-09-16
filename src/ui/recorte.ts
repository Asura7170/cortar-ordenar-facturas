/* Recorte manual por comprobante: modal con la imagen fija en el canvas base
   y 8 tiradores (4 lados + 4 esquinas) sobre el overlay. Confirmar commitea
   el recorte como JPEG y relee el OCR (igual que el giro). Estado efímero. */
import { buscarSlot, obtenerComprobante } from "../state";
import { asignarMiniatura, generarMiniatura } from "../pipeline/queue";
import { releerTrasEdicion } from "../pipeline/rotar";
import { CALIDAD_JPEG, cargarReal, crearReal } from "../pipeline/imagen";
import type { DepsOcr } from "../pipeline/ocr";
import { getEl } from "../utils";

const modal: HTMLDialogElement = getEl<HTMLDialogElement>("modalRecorte");
const base: HTMLCanvasElement = getEl<HTMLCanvasElement>("recorteBase");
const guia: HTMLCanvasElement = getEl<HTMLCanvasElement>("recorteGuia");
const btnOk: HTMLButtonElement = getEl<HTMLButtonElement>("btnRecorteOk");
const btnReset: HTMLButtonElement = getEl<HTMLButtonElement>("btnRecorteReset");
const aviso: HTMLElement = getEl("avisoRecorte");

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

const RADIO_HIT = 22; // hit-area táctil; el visual es de 12px
const LADO_VISUAL = 12;
const MIN_LADO = 24; // lado mínimo en px display (el natural se valida al confirmar)
const MIN_NATURAL = 8; // lado mínimo en px naturales al confirmar
const PASO_TECLA = 2;

let idAbierto: number | null = null;
let bmp: ImageBitmap | null = null;
let escala = 1; // px naturales por px display
let cw = 0;
let ch = 0;
let rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
let activo = 7; // índice del tirador activo (empieza en "se")
let enArrastre = false;
let raf: number | null = null;
let depsVigentes: DepsOcr | undefined;

function avisar(texto: string): void {
  const el = document.getElementById("aviso");
  if (el) el.textContent = texto;
}

/** Abre el editor para el comprobante (no-op fuera de ok o sin bitmap). */
export async function abrirRecorte(id: number, deps?: DepsOcr): Promise<void> {
  if (modal.open) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  const cargar = deps?.cargar ?? cargarReal;
  let foto: ImageBitmap;
  try {
    const original = item.file ?? (await (await fetch(item.imgUrl)).blob());
    foto = await cargar(original);
  } catch {
    avisar("No se pudo abrir el recorte.");
    return;
  }
  if (foto.width < 2 || foto.height < 2) {
    foto.close();
    return;
  }
  cerrarAnterior();
  idAbierto = id;
  bmp = foto;
  depsVigentes = deps;
  modal.showModal();
  // La escena ya tiene layout (el dialog está abierto): encajar sin ampliar.
  const escena = guia.parentElement;
  const maxW = Math.min(escena?.clientWidth || 860, 860);
  const maxH = Math.min(window.innerHeight * 0.6, 560);
  const k = Math.min(maxW / foto.width, maxH / foto.height, 1);
  cw = Math.max(1, Math.round(foto.width * k));
  ch = Math.max(1, Math.round(foto.height * k));
  escala = foto.width / cw;
  const dpr = window.devicePixelRatio || 1;
  for (const c of [base, guia]) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(ch * dpr);
    c.style.width = `${cw}px`;
    c.style.height = `${ch}px`;
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
  ctxBase.drawImage(foto, 0, 0, cw, ch);
  restablecer();
  aviso.textContent = "";
}

function restablecer(): void {
  rect = { x: 0, y: 0, w: cw, h: ch };
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
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, cw, rect.y);
  ctx.fillRect(0, rect.y + rect.h, cw, ch - rect.y - rect.h);
  ctx.fillRect(0, rect.y, rect.x, rect.h);
  ctx.fillRect(rect.x + rect.w, rect.y, cw - rect.x - rect.w, rect.h);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  TIRADORES.forEach((t, i) => {
    const hx = rect.x + rect.w * t.fx;
    const hy = rect.y + rect.h * t.fy;
    const l = LADO_VISUAL / 2;
    ctx.fillStyle = i === activo ? "#1d7a3a" : "#fff";
    ctx.fillRect(hx - l, hy - l, LADO_VISUAL, LADO_VISUAL);
    ctx.lineWidth = 2;
    ctx.strokeStyle = i === activo ? "#fff" : "#1d7a3a";
    ctx.strokeRect(hx - l, hy - l, LADO_VISUAL, LADO_VISUAL);
  });
}

function punto(e: PointerEvent): { x: number; y: number } {
  const r = guia.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function tiradorEn(p: { x: number; y: number }): number {
  for (const [i, t] of TIRADORES.entries()) {
    const hx = rect.x + rect.w * t.fx;
    const hy = rect.y + rect.h * t.fy;
    if (Math.hypot(p.x - hx, p.y - hy) <= RADIO_HIT) return i;
  }
  return -1;
}

/** Mueve los bordes del tirador al punto (siempre dentro de la imagen). */
function moverA(b: Borde, p: { x: number; y: number }): void {
  const der0 = rect.x + rect.w;
  const aba0 = rect.y + rect.h;
  let izq = rect.x;
  let arr = rect.y;
  let der = der0;
  let aba = aba0;
  if (b === "n" || b === "ne" || b === "no") arr = Math.min(Math.max(p.y, 0), aba0 - MIN_LADO);
  if (b === "s" || b === "se" || b === "so") aba = Math.max(Math.min(p.y, ch), arr + MIN_LADO);
  if (b === "o" || b === "no" || b === "so") izq = Math.min(Math.max(p.x, 0), der0 - MIN_LADO);
  if (b === "e" || b === "ne" || b === "se") der = Math.max(Math.min(p.x, cw), izq + MIN_LADO);
  rect = { x: izq, y: arr, w: der - izq, h: aba - arr };
  pedirGuia();
}

/** Confirma: recorta en píxeles naturales, commitea y relee el OCR. Nunca lanza. */
async function confirmar(): Promise<void> {
  const id = idAbierto;
  const foto = bmp;
  if (id === null || !foto) return;
  const item = obtenerComprobante(id);
  if (!item || item.estado !== "ok") return;
  const crear = depsVigentes?.crear ?? crearReal;
  try {
    const sx = Math.min(Math.round(rect.x * escala), foto.width - 1);
    const sy = Math.min(Math.round(rect.y * escala), foto.height - 1);
    const w = Math.min(Math.round(rect.w * escala), foto.width - sx);
    const h = Math.min(Math.round(rect.h * escala), foto.height - sy);
    if (w < MIN_NATURAL || h < MIN_NATURAL) {
      aviso.textContent = "El recorte es demasiado pequeño.";
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
    // ponytail: commit tras los awaits (igual que la cola: sin dueño no se guarda).
    if (!buscarSlot(id)) return;
    URL.revokeObjectURL(item.imgUrl);
    item.imgUrl = URL.createObjectURL(recortado);
    item.file = recortado;
    const thumb = await generarMiniatura(recortado);
    if (thumb && buscarSlot(id)) asignarMiniatura(item, thumb);
    else if (buscarSlot(id)) item.thumbUrl = item.imgUrl;
    modal.close();
    const { renderHojas } = await import("./sheets");
    renderHojas();
    void releerTrasEdicion(id, recortado, depsVigentes);
  } catch {
    avisar("No se pudo recortar la imagen.");
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
    cerrarAnterior();
  });

  guia.addEventListener("pointerdown", (e) => {
    if (!bmp || !e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const i = tiradorEn(punto(e));
    if (i < 0) return;
    e.preventDefault();
    activo = i;
    enArrastre = true;
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
      moverA(TIRADORES[activo]?.b ?? "se", p);
      return;
    }
    // ponytail: cursor del tirador bajo el puntero sin redibujar (barato).
    const i = tiradorEn(p);
    guia.style.cursor = i < 0 ? "default" : (TIRADORES[i]?.cursor ?? "default");
  });
  const soltar = (): void => {
    enArrastre = false;
  };
  guia.addEventListener("pointerup", soltar);
  guia.addEventListener("pointercancel", soltar);

  // Teclado: Tab rota el tirador activo, flechas lo mueven, Enter confirma.
  guia.addEventListener("keydown", (e) => {
    if (!bmp) return;
    if (e.key === "Tab") {
      e.preventDefault();
      activo = (activo + (e.shiftKey ? TIRADORES.length - 1 : 1)) % TIRADORES.length;
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
