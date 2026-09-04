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
import { buscarSlot } from "../state";
import { getEl, sanear } from "../utils";

const dropzone: HTMLElement = getEl("dropzone");
const fileInput: HTMLInputElement = getEl<HTMLInputElement>("fileInput");
const chkCodigo: HTMLInputElement = getEl<HTMLInputElement>("chkCodigo");
const numCodigo: HTMLInputElement = getEl<HTMLInputElement>("numCodigo");
const inputCodigo: HTMLInputElement = getEl<HTMLInputElement>("inputCodigo");
const modalLimpiar: HTMLDialogElement = getEl<HTMLDialogElement>("modalLimpiar");

// Si hojaId se indica, rellena los huecos de ESA hoja (y crea al final si
// sobran); si no, usa la última hoja con hueco.
export function agregarArchivos(
  files: FileList | readonly File[] | null | undefined,
  hojaId: number | null = null,
): void {
  const lista: File[] = files instanceof FileList ? Array.from(files) : [...(files ?? [])];
  const validos = lista.filter(
    (f) =>
      /^image\/(jpeg|png|webp|bmp|gif)$/i.test(f.type) || f.name.toLowerCase().endsWith(".pdf"),
  );
  const nuevas: Comprobante[] = validos.map((f) => ({
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
  }));
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
    if (!item.file || !/^image\//i.test(item.file.type)) return; // PDF: sin miniatura
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
    agregarArchivos(fileInput.files);
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
    agregarArchivos(e.dataTransfer?.files);
  });
  document.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length) agregarArchivos(files);
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
