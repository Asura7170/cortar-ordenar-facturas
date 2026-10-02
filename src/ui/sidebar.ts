/* Sidebar: código de pedido, limpiar y reintento IA. La entrada vive en el
   canvas (tarjeta grande + drop en el área): acá solo se cablea. */
import {
  borrarCodigo,
  crearHoja,
  guardarCodigo,
  hojaPorId,
  isPosicionCodigo,
  nextComprobanteId,
  state,
} from "../state";
import type { Comprobante } from "../types";
import { cuentaHoja, itemsDe } from "./monto";
import { layoutDe } from "./layout";
import { esDragDeArchivos, renderHojas } from "./sheets";
import { precalentarModelos, procesarCola } from "../pipeline/queue";
import { extraerPendientes } from "../pipeline/extract";
import { admitirPdf, contarPaginasPdf, esPdf, expandirPdf } from "../pipeline/pdf";
import type { MotivoRechazo } from "../pipeline/pdf";
import { normalizarImagen } from "../pipeline/imagen";
import { getEl, sanear } from "../utils";

const canvas: HTMLElement = getEl("canvas");
const fileInput: HTMLInputElement = getEl<HTMLInputElement>("fileInput");
const dropzone: HTMLElement = getEl("dropzone");
const chkCodigo: HTMLInputElement = getEl<HTMLInputElement>("chkCodigo");
const numCodigo: HTMLInputElement = getEl<HTMLInputElement>("numCodigo");
const inputCodigo: HTMLInputElement = getEl<HTMLInputElement>("inputCodigo");
// ponytail: por name (no getEl): si el fieldset falta, lista vacía sin reventar.
function radiosPosicion(): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>('input[name="posCodigo"]');
}
const modalLimpiar: HTMLDialogElement = getEl<HTMLDialogElement>("modalLimpiar");
const aviso: HTMLElement = getEl("aviso");
const btnIA: HTMLButtonElement = getEl<HTMLButtonElement>("btnIA");
const btnPegar: HTMLButtonElement = getEl<HTMLButtonElement>("btnPegar");

/** Rechazo de entrada: nombre en tono tenue + motivo en rojo sello. */
interface AvisoRechazo {
  readonly archivo: string;
  readonly motivo: string;
}

/** Aviso de entrada (rechazos del filtro/gate). Sobrescribe el anterior.
    Sin innerHTML: el nombre va como nodo de texto (a prueba de marcado). */
function avisar(rechazos: readonly AvisoRechazo[]): void {
  const nodos: (Text | HTMLSpanElement)[] = [];
  rechazos.forEach((r, i) => {
    if (i > 0) nodos.push(document.createTextNode(" · "));
    nodos.push(document.createTextNode(`«${r.archivo}»: `));
    const m = document.createElement("span");
    m.className = "motivo";
    m.textContent = r.motivo;
    nodos.push(m);
  });
  aviso.replaceChildren(...nodos);
}

function textoMotivo(m: MotivoRechazo): string {
  switch (m) {
    case "tamano":
      return "pesa más de 5 MB";
    case "paginas":
      return "tiene más de 10 páginas";
    case "cifrado":
      return "protegido con contraseña";
    case "ilegible":
      return "no se pudo leer";
  }
}

// Si hojaId se indica, rellena los huecos de ESA hoja (y crea al final si
// sobran); si no, usa la última hoja con hueco.
// ponytail: contador, no booleano — dos intakes solapados (paste durante un
// PDF largo) no sueltan loteEnCurso a mitad del otro.
let intakesActivos = 0;

// Formatos de imagen del intake (clic / Ctrl+V / drop): un solo allowlist.
const MIME_IMAGEN: RegExp = /^image\/(jpeg|png|webp|bmp|gif)$/i;

/** Hoja destino del próximo picker (botón ＋ de la hoja); null = automático. */
let hojaPedida: number | null = null;

/** Comprobante pendiente desde un blob normalizado (vías clic e intake). */
function comprobanteDesdeBlob(blob: Blob, nombre: string): Comprobante {
  return {
    id: nextComprobanteId(),
    nombre: sanear(nombre),
    file: blob,
    imgUrl: URL.createObjectURL(blob),
    textoOcr: "",
    montoCents: null,
    montoManual: false,
    moneda: "USD",
    estado: "pendiente",
    posicion: 0,
  };
}
export async function agregarArchivos(
  files: FileList | readonly File[] | null | undefined,
  hojaId: number | null = null,
): Promise<void> {
  // Cualquier intake consume la hoja pedida (picker, drop, paste): si no, la
  // pendiente sobrevive y el próximo picker cae en una hoja abandonada.
  const destino = hojaId ?? hojaPedida;
  hojaPedida = null;
  const lista: File[] = files instanceof FileList ? Array.from(files) : [...(files ?? [])];
  const esImagen = (f: File): boolean => MIME_IMAGEN.test(f.type);
  const avisos: AvisoRechazo[] = lista
    .filter((f) => !esImagen(f) && !esPdf(f))
    .map((f) => ({ archivo: sanear(f.name), motivo: "formato no soportado" }));
  // Commit incremental: cada archivo se pinta antes del siguiente. Los gaps
  // async del decode/encode le dan al navegador ventanas de paint con DOM ya
  // comprometido (antes solo había un render al final del lote: freeze).
  let hoja = destino != null ? hojaPorId(destino) : undefined;
  // Perezosa: el intake vacío o todo-rechazado no crea hojas (el test
  // "null o vacío" lo exige; antes el return temprano lo garantizaba).
  const asegurarHoja = (): NonNullable<typeof hoja> => {
    if (!hoja) {
      hoja =
        state.hojas.find((h) => cuentaHoja(h) < layoutDe(h.layout).total) ??
        state.hojas[state.hojas.length - 1] ??
        crearHoja();
      if (!state.hojas.includes(hoja)) state.hojas.push(hoja);
    }
    return hoja;
  };
  const llenar = (slots: (Comprobante | null)[], resto: Comprobante[]): void => {
    for (let j = 0; j < slots.length && resto.length; j++) {
      if (!slots[j]) slots[j] = resto.shift() ?? null;
    }
  };
  let colocados = 0;
  let ultimoRender = 0;
  // ponytail: cede el turno por archivo (scheduler.yield en Chrome = ventana de
  // paint/scroll; microtask en tests/jsdom para no colgar los timers falsos).
  const cederTurno = (): Promise<void> =>
    (
      globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }
    ).scheduler?.yield?.() ?? Promise.resolve();
  // Telemetría del intake (solo DEV): pared vs costo de normalización por foto.
  const tIntake = performance.now();
  const msNorm: number[] = [];
  const colocar = (items: Comprobante[]): void => {
    if (items.length === 0) return;
    let actual = asegurarHoja();
    llenar(actual.slots, items);
    while (items.length) {
      actual = crearHoja(actual.layout);
      hoja = actual;
      state.hojas.push(actual);
      llenar(actual.slots, items);
    }
    colocados += 1;
    const ahora = performance.now();
    // ponytail: 1ª foto al instante (feedback); luego 1 render cada 300ms + 1 final.
    if (colocados === 1 || ahora - ultimoRender >= 300) {
      ultimoRender = ahora;
      renderHojas();
    }
  };
  // Sin VT ni rebuilds por archivo durante el intake (ver sheets.renderHojas):
  // el flag cubre todo el loop y el finally lo suelta aunque un PDF falle.
  intakesActivos++;
  state.loteEnCurso = true;
  try {
    for (const f of lista) {
      await cederTurno();
      if (esImagen(f)) {
        // Intake: jpg/png/webp sin nada que corregir pasa crudo (0 gens);
        // lo demás se empaqueta a WebP. Blanca/corrupta → aviso, sin tumbar el lote.
        // ponytail: secuencial a propósito; N decodes en paralelo saturan memoria.
        try {
          const tN = performance.now();
          const blob = await normalizarImagen(f);
          if (import.meta.env.DEV) msNorm.push(performance.now() - tN);
          colocar([comprobanteDesdeBlob(blob, f.name)]);
        } catch {
          avisos.push({ archivo: sanear(f.name), motivo: "no se pudo leer" });
        }
        continue;
      }
      if (!esPdf(f)) continue;
      // Gate + fan-out por archivo (secuencial): cada página no-blanca = un
      // comprobante "base p.i/N". Blancas en silencio; sin útiles → aviso.
      const veredicto = await admitirPdf(f, contarPaginasPdf);
      if (veredicto?.admite !== true) {
        avisos.push({
          archivo: sanear(f.name),
          motivo: textoMotivo(veredicto?.motivo ?? "ilegible"),
        });
        continue;
      }
      const pags = await expandirPdf(f);
      if (pags.length === 0) {
        avisos.push({ archivo: sanear(f.name), motivo: "no se pudo leer" });
        continue;
      }
      const base = sanear(f.name).replace(/\.pdf$/i, "");
      colocar(
        pags.map((p) => {
          const url = URL.createObjectURL(p.blob);
          return {
            id: nextComprobanteId(),
            nombre: `${base} p.${p.indice}/${p.total}`,
            imgUrl: url,
            textoOcr: "",
            montoCents: null,
            montoManual: false,
            moneda: "USD",
            estado: "pendiente",
            posicion: 0,
          } satisfies Comprobante;
        }),
      );
    }
  } finally {
    intakesActivos--;
    state.loteEnCurso = intakesActivos > 0;
  }
  if (import.meta.env.DEV && msNorm.length > 0) {
    const ordenadas = [...msNorm].sort((a, b) => a - b);
    const cuantil = (q: number): number =>
      Math.round(
        ordenadas[Math.min(ordenadas.length - 1, Math.ceil(q * ordenadas.length) - 1)] ?? 0,
      );
    console.info(
      `intake ms pared=${Math.round(performance.now() - tIntake)} n=${msNorm.length} ` +
        `normP50=${cuantil(0.5)} normMax=${cuantil(1)}`,
    );
  }
  avisar(avisos); // siempre: con [] limpia un rechazo viejo de otro lote.
  if (colocados === 0) return;

  renderHojas();
  precalentarModelos(); // warm-up tras el intake: sin competir con los decodes
  void procesarCola();
}

/** Item del portapapeles con al menos una imagen (shape mínimo de ClipboardItem). */
interface ItemConImagen {
  readonly types: readonly string[];
  getType(tipo: string): Promise<Blob>;
}

// Sin bytes de imagen el clic no puede pegar: el Ctrl+C al ARCHIVO en el
// Explorador deja una referencia (no bytes) y el navegador no la entrega vía
// read() — ese caso solo entra por Ctrl+V o la tarjeta. El mensaje cubre ambos.
const MOTIVO_SIN_IMAGEN: string =
  "no hay imagen para pegar: en WhatsApp usa clic derecho > Copiar imagen; si copiaste el archivo en el Explorador, pega con Ctrl+V";

// Lee los bytes de imagen del portapapeles del SO. Null = ya se avisó.
// El read() corre sin await previo: el gesto del clic lo autoriza en Chrome.
async function leerImagenesPortapapeles(): Promise<File[] | null> {
  const lector = (
    globalThis as unknown as {
      navigator?: { clipboard?: { read?: () => Promise<ItemConImagen[]> } };
    }
  ).navigator?.clipboard;
  if (typeof lector?.read !== "function") {
    avisar([
      {
        archivo: "Portapapeles",
        motivo: "este navegador no permite pegar con clic: usa Ctrl+V",
      },
    ]);
    return null;
  }
  let items: readonly ItemConImagen[];
  try {
    items = await lector.read();
  } catch {
    avisar([{ archivo: "Portapapeles", motivo: MOTIVO_SIN_IMAGEN }]);
    return null;
  }
  const archivos: File[] = [];
  let formatoNoSoportado = false;
  for (const item of items) {
    const tipo = (item.types ?? []).find((t) => t.startsWith("image/"));
    if (!tipo) continue;
    const cruda = (tipo.split("/")[1] ?? "").split(";")[0]?.toLowerCase() ?? "";
    if (!MIME_IMAGEN.test(`image/${cruda}`)) {
      formatoNoSoportado = true; // mismo mensaje que Ctrl+V para esos bytes
      continue;
    }
    try {
      const blob = await item.getType(tipo);
      archivos.push(new File([blob], `pegado.${cruda}`, { type: `image/${cruda}` }));
    } catch {
      // item ilegible: se ignora; el aviso final cubre el vacío total
    }
  }
  if (archivos.length === 0) {
    avisar([
      {
        archivo: "Portapapeles",
        motivo: formatoNoSoportado ? "formato no soportado" : MOTIVO_SIN_IMAGEN,
      },
    ]);
    return null;
  }
  return archivos;
}

// Clic en celda vacía: lee la imagen del portapapeles del SO (copiada en
// WhatsApp con clic derecho > Copiar imagen) y la coloca en ese slot exacto.
export async function pegarEnCelda(hojaId: number, slotIdx: number): Promise<void> {
  const destino = hojaPorId(hojaId);
  if (!destino) return;
  // Elección explícita de destino: consume la pendiente del picker (si no, el
  // próximo intake caería en una hoja abandonada).
  hojaPedida = null;
  const archivos = await leerImagenesPortapapeles();
  if (!archivos) return;
  intakesActivos++;
  state.loteEnCurso = true;
  try {
    const primero = archivos[0];
    if (!primero) return;
    try {
      const blob = await normalizarImagen(primero);
      const comp: Comprobante = comprobanteDesdeBlob(blob, primero.name);
      const h = hojaPorId(hojaId);
      const libreExacto = h && slotIdx >= 0 && slotIdx < h.slots.length && h.slots[slotIdx] == null;
      if (libreExacto && h) {
        h.slots[slotIdx] = comp;
      } else if (h && h.slots.includes(null)) {
        const libre = h.slots.indexOf(null);
        if (libre >= 0) h.slots[libre] = comp;
      } else {
        // Hoja llena: flujo normal (última con hueco o nueva heredando layout).
        const actual =
          state.hojas.find((x) => x.slots.includes(null)) ??
          (() => {
            const nueva = crearHoja(h?.layout ?? "u4x2");
            state.hojas.push(nueva);
            return nueva;
          })();
        const libre = actual.slots.indexOf(null);
        if (libre >= 0) actual.slots[libre] = comp;
      }
      renderHojas();
    } catch {
      avisar([{ archivo: sanear(primero.name), motivo: "no se pudo leer" }]);
      return;
    }
    // Resto (raro desde WhatsApp): llena la hoja clicada y desborda como el flujo normal.
    const resto = archivos.slice(1);
    if (resto.length > 0) await agregarArchivos(resto, hojaId);
    else avisar([]); // éxito: limpia un rechazo viejo de otro intento
    precalentarModelos();
    void procesarCola();
  } finally {
    intakesActivos--;
    state.loteEnCurso = intakesActivos > 0;
  }
}

// Lote vacío (botón bajo la tarjeta): pega lo copiado sin destino,
// por el flujo normal de entrada (crea la hoja sola).
export async function pegarDelPortapapeles(): Promise<void> {
  const archivos = await leerImagenesPortapapeles();
  if (!archivos) return;
  await agregarArchivos(archivos);
}

export function renderCodigo(): void {
  chkCodigo.checked = state.codigoActivo;
  numCodigo.value = String(state.codigoLongitud);
  inputCodigo.value = state.codigoValor;
  inputCodigo.maxLength = state.codigoLongitud;
  inputCodigo.disabled = !state.codigoActivo;
  inputCodigo.placeholder = state.codigoActivo
    ? `Código (${state.codigoLongitud} dígitos)`
    : "Código";
  // ponytail: el error visual vive hasta que el usuario corrige o se re-renderiza.
  inputCodigo.classList.remove("codigo-error", "sacudir");
  inputCodigo.removeAttribute("aria-invalid");
  radiosPosicion().forEach((r) => {
    r.checked = r.value === state.codigoPosicion;
    r.disabled = !state.codigoActivo;
  });
}

/** Abre el diálogo para subir directo a una hoja (la consume cualquier intake). */
export function elegirArchivos(hojaId: number): void {
  hojaPedida = hojaId;
  // ponytail: sin fallback click (Chrome latest tiene showPicker; el repo los prohíbe).
  fileInput.showPicker();
}

export function initSidebar(): void {
  // El label solo reenvía clics: Enter/Espacio sobre él no abren el picker
  // (sin activation behavior propio), por eso el keydown es manual.
  dropzone.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.showPicker();
  });
  fileInput.addEventListener("change", () => {
    void agregarArchivos(fileInput.files, hojaPedida);
    hojaPedida = null;
    fileInput.value = "";
  });
  // Cancelar el diálogo no dispara change: sin esto la hoja pedida queda
  // rancia y el próximo intake (tarjeta, drop, paste) cae en la hoja vieja.
  fileInput.addEventListener("cancel", () => {
    hojaPedida = null;
  });
  // Entrada a nivel canvas: cualquier punto del área (fondo, tarjeta, botón)
  // acepta archivos; sobre una hoja manda sheets.ts con su hojaId.
  // La entrada nunca se bloquea por el modo OCR (solo el reordenamiento).
  // Contador dragenter/dragleave: sin esto el overlay parpadea por cada hijo.
  let arrastres = 0;
  const marcar = (n: number): void => {
    arrastres = Math.max(0, n);
    canvas.classList.toggle("arrastrando", arrastres > 0);
  };
  // Head-start: entrar al canvas anticipa la intención (una sola vez).
  canvas.addEventListener("pointerenter", () => precalentarModelos(), { once: true });
  canvas.addEventListener("dragenter", (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    marcar(arrastres + 1);
  });
  canvas.addEventListener("dragover", (e) => {
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
  });
  canvas.addEventListener("dragleave", (e) => {
    if (!esDragDeArchivos(e)) return;
    marcar(arrastres - 1);
  });
  canvas.addEventListener("drop", (e) => {
    marcar(0);
    if (!esDragDeArchivos(e)) return;
    e.preventDefault();
    if ((e.target as HTMLElement | null)?.closest?.(".sheet")) return;
    void agregarArchivos(e.dataTransfer?.files);
  });
  // Red de seguridad: un drop fallado fuera del canvas no navega el navegador
  // (perdería el lote en memoria). Fuera del canvas no se sube nada.
  window.addEventListener("dragover", (e) => {
    if (esDragDeArchivos(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    marcar(0);
    if (esDragDeArchivos(e)) e.preventDefault();
  });
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) marcar(0); // el arrastre salió de la ventana
  });
  document.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) void agregarArchivos(files);
  });
  // Lote vacío: el botón pega lo copiado sin abrir el buscador.
  // ponytail: lock por botón (el read() es async: sin esto el doble-clic pega dos veces).
  btnPegar.addEventListener("click", () => {
    if (btnPegar.dataset["pegando"] === "1") return;
    btnPegar.dataset["pegando"] = "1";
    void pegarDelPortapapeles().finally(() => {
      delete btnPegar.dataset["pegando"];
    });
  });

  // Reintento manual del lote IA (el auto corre al drenar la cola).
  btnIA.addEventListener("click", () => {
    void extraerPendientes({ forzado: true });
  });

  // El switch solo arma el guardado de su ventana; ON no escribe, OFF retira lo suyo.
  chkCodigo.addEventListener("change", () => {
    state.codigoActivo = chkCodigo.checked;
    if (!chkCodigo.checked) borrarCodigo();
    renderCodigo();
  });
  numCodigo.addEventListener("input", () => {
    state.codigoLongitud = Math.max(1, Math.min(12, Math.floor(Number(numCodigo.value)) || 6));
    if (chkCodigo.checked) guardarCodigo();
    renderCodigo();
  });
  // La esquina es otro dato de la ventana Código: cambiarla persiste igual.
  radiosPosicion().forEach((r) =>
    r.addEventListener("change", () => {
      if (!r.checked || !isPosicionCodigo(r.value)) return;
      state.codigoPosicion = r.value;
      if (chkCodigo.checked) guardarCodigo();
    }),
  );
  inputCodigo.addEventListener("input", () => {
    state.codigoValor = inputCodigo.value.replace(/\D/g, "").slice(0, state.codigoLongitud);
    inputCodigo.value = state.codigoValor;
    // ponytail: al teclear se levanta el error; el gate lo repone si sigue inválido.
    inputCodigo.classList.remove("codigo-error", "sacudir");
    inputCodigo.removeAttribute("aria-invalid");
    if (chkCodigo.checked) guardarCodigo();
  });

  // El botón Limpiar abre el dialog vía commandfor (cero JS); acá solo se
  // ejecuta el vaciado si se confirmó. Esc/backdrop/Cancelar → returnValue ''.
  modalLimpiar.addEventListener("close", () => {
    if (modalLimpiar.returnValue !== "ok") return;
    hojaPedida = null; // la hoja destino pudo dejar de existir
    for (const h of state.hojas)
      for (const c of itemsDe(h)) {
        URL.revokeObjectURL(c.imgUrl);
      }
    state.hojas = [crearHoja()];
    // ponytail: cada lote trae código distinto; solo el número, resto intacto.
    state.codigoValor = "";
    renderCodigo();
    renderHojas();
    // Último: si el storage falla, los renders ya corrieron.
    if (state.codigoActivo) guardarCodigo();
  });
}
