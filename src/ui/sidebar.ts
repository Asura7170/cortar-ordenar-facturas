/* Sidebar: entrada (dropzone/pegar/subir), código de pedido y limpiar. */
import {
  borrarCodigo,
  crearHoja,
  guardarCodigo,
  hojaPorId,
  nextComprobanteId,
  state,
} from "../state";
import type { Comprobante } from "../types";
import { cuentaHoja, itemsDe } from "./monto";
import { layoutDe } from "./layout";
import { actualizarMiniatura, renderHojas } from "./sheets";
import { generarMiniatura, procesarCola } from "../pipeline/queue";
import { admitirPdf, contarPaginasPdf, esPdf, expandirPdf } from "../pipeline/pdf";
import type { MotivoRechazo, PaginaPdf } from "../pipeline/pdf";
import { buscarSlot } from "../state";
import { getEl, sanear } from "../utils";

const dropzone: HTMLElement = getEl("dropzone");
const fileInput: HTMLInputElement = getEl<HTMLInputElement>("fileInput");
const chkCodigo: HTMLInputElement = getEl<HTMLInputElement>("chkCodigo");
const numCodigo: HTMLInputElement = getEl<HTMLInputElement>("numCodigo");
const inputCodigo: HTMLInputElement = getEl<HTMLInputElement>("inputCodigo");
const modalLimpiar: HTMLDialogElement = getEl<HTMLDialogElement>("modalLimpiar");
const aviso: HTMLElement = getEl("aviso");

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
export async function agregarArchivos(
  files: FileList | readonly File[] | null | undefined,
  hojaId: number | null = null,
): Promise<void> {
  const lista: File[] = files instanceof FileList ? Array.from(files) : [...(files ?? [])];
  const esImagen = (f: File): boolean => /^image\/(jpeg|png|webp|bmp|gif)$/i.test(f.type);
  const pdfs: File[] = lista.filter((f) => !esImagen(f) && esPdf(f));
  const avisos: AvisoRechazo[] = lista
    .filter((f) => !esImagen(f) && !esPdf(f))
    .map((f) => ({ archivo: sanear(f.name), motivo: "formato no soportado" }));
  // Gate por archivo (independiente): tamaño sync + páginas async, en orden.
  // Solo lo admitido se vuelve comprobante (sin blob URL para rechazados).
  const veredictos = await Promise.all(pdfs.map((f) => admitirPdf(f, contarPaginasPdf)));
  const pdfOk = new Set<File>();
  pdfs.forEach((f, i) => {
    const v = veredictos[i];
    if (v?.admite === true) pdfOk.add(f);
    else avisos.push({ archivo: sanear(f.name), motivo: textoMotivo(v?.motivo ?? "ilegible") });
  });
  // Fan-out PDF: cada página no-blanca = un comprobante "base p.i/N" (mismo
  // blob para img+thumb; un render por página). Blancas en silencio; si no
  // queda ninguna útil, aviso "no se pudo leer".
  const expansiones: PaginaPdf[][] = await Promise.all(
    pdfs.map((f) => (pdfOk.has(f) ? expandirPdf(f) : Promise.resolve([]))),
  );
  const nuevas: Comprobante[] = [];
  for (const f of lista) {
    if (esImagen(f)) {
      nuevas.push({
        id: nextComprobanteId(),
        nombre: sanear(f.name),
        file: f,
        imgUrl: URL.createObjectURL(f),
        thumbUrl: null,
        textoOcr: "",
        montoCents: null,
        moneda: "USD",
        estado: "pendiente",
        posicion: 0,
      });
      continue;
    }
    if (!pdfOk.has(f)) continue;
    const pags = expansiones[pdfs.indexOf(f)] ?? [];
    if (pags.length === 0) {
      avisos.push({ archivo: sanear(f.name), motivo: "no se pudo leer" });
      continue;
    }
    const base = sanear(f.name).replace(/\.pdf$/i, "");
    for (const p of pags) {
      const url = URL.createObjectURL(p.blob);
      nuevas.push({
        id: nextComprobanteId(),
        nombre: `${base} p.${p.indice}/${p.total}`,
        imgUrl: url,
        thumbUrl: url,
        textoOcr: "",
        montoCents: null,
        moneda: "USD",
        estado: "pendiente",
        posicion: 0,
      });
    }
  }
  avisar(avisos); // siempre: con [] limpia un rechazo viejo de otro lote.
  if (nuevas.length === 0) return;
  const recienIngresados = [...nuevas]; // llenar() vacía `nuevas` con shift()

  let hoja = hojaId != null ? hojaPorId(hojaId) : undefined;
  if (!hoja) {
    hoja =
      state.hojas.find((h) => cuentaHoja(h) < layoutDe(h.layout).total) ??
      state.hojas[state.hojas.length - 1] ??
      crearHoja();
    if (!state.hojas.includes(hoja)) state.hojas.push(hoja);
  }
  const llenar = (slots: (Comprobante | null)[], resto: Comprobante[]): void => {
    for (let j = 0; j < slots.length && resto.length; j++) {
      if (!slots[j]) slots[j] = resto.shift() ?? null;
    }
  };
  llenar(hoja.slots, nuevas);
  while (nuevas.length) {
    hoja = crearHoja(hoja.layout);
    state.hojas.push(hoja);
    llenar(hoja.slots, nuevas);
  }
  renderHojas();
  void procesarCola();

  // Miniaturas en segundo plano, de 3 en 3: N createImageBitmap en paralelo
  // saturan memoria en lotes grandes. Cada casilla se repinta sola al estar
  // lista (esqueleto → thumb: una sola decodificación por foto).
  // ponytail: concurrencia fija 3; pool dinámico solo si 3 se queda corto.
  const pintarMiniatura = async (item: Comprobante): Promise<void> => {
    if (!item.file) return;
    const url = await generarMiniatura(item.file);
    if (!url) return;
    if (!buscarSlot(item.id)) {
      URL.revokeObjectURL(url);
      return;
    }
    item.thumbUrl = url;
    actualizarMiniatura(item.id);
  };
  void (async () => {
    for (let i = 0; i < recienIngresados.length; i += 3) {
      await Promise.all(recienIngresados.slice(i, i + 3).map(pintarMiniatura));
    }
  })();
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
}

export function initSidebar(): void {
  // ponytail: label[for] nativo ya abre el diálogo con Enter/Espacio; sin keydown manual.
  fileInput.addEventListener("change", () => {
    void agregarArchivos(fileInput.files);
    fileInput.value = "";
  });
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    void agregarArchivos(e.dataTransfer?.files);
  });
  document.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) void agregarArchivos(files);
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
  inputCodigo.addEventListener("input", () => {
    state.codigoValor = inputCodigo.value.replace(/\D/g, "").slice(0, state.codigoLongitud);
    inputCodigo.value = state.codigoValor;
    if (chkCodigo.checked) guardarCodigo();
  });

  // El botón Limpiar abre el dialog vía commandfor (cero JS); acá solo se
  // ejecuta el vaciado si se confirmó. Esc/backdrop/Cancelar → returnValue ''.
  modalLimpiar.addEventListener("close", () => {
    if (modalLimpiar.returnValue !== "ok") return;
    for (const h of state.hojas)
      for (const c of itemsDe(h)) {
        URL.revokeObjectURL(c.imgUrl);
        if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
      }
    state.hojas = [crearHoja()];
    renderHojas();
  });
}
