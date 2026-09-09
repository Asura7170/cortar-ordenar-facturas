/* Fixture DOM mínimo: los módulos UI resuelven getEl() al importarse, así que el
   HTML debe estar montado ANTES del import dinámico del módulo bajo test. */
export const FIXTURE_HTML = `
<div id="montoTotal"></div>
<div class="zoom-grupo">
<button id="btnZoomMenos"></button>
<button id="btnZoom" hidden></button>
<button id="btnZoomMas"></button>
<button id="btnLupa" aria-pressed="false"></button>
</div>
<main class="canvas" id="canvas">
  <div class="canvas-head"><span id="metaHojas"></span></div>
  <p id="aviso" role="status"></p>
  <div id="sheets"></div>
  <label id="dropzone" for="fileInput" tabindex="0"></label>
  <input id="fileInput" type="file" multiple>
</main>
<div id="lupa" aria-hidden="true"><canvas id="lupaCanvas"></canvas></div>
<input id="chkCodigo" type="checkbox">
<input id="numCodigo" type="number" value="6">
<input id="inputCodigo" type="text">
<fieldset>
  <input type="radio" name="posCodigo" value="sup-izq">
  <input type="radio" name="posCodigo" value="sup-der">
  <input type="radio" name="posCodigo" value="inf-izq">
  <input type="radio" name="posCodigo" value="inf-der">
</fieldset>
<dialog id="modalLimpiar"></dialog>
<input id="chkOcr" type="checkbox">
<span id="ocrEstado"></span>
<dialog id="modalAjustes"></dialog>
<button id="btnAjustes"></button>
<form id="formAjustes" method="dialog">
  <input id="cfgBaseUrl">
  <input id="cfgModel">
  <input id="cfgApiKey" type="password">
  <select id="cfgMoneda">
    <option value="USD">USD</option><option value="ARS">ARS</option>
    <option value="EUR">EUR</option><option value="BOB">BOB</option>
  </select>
  <button id="btnResetAjustes" type="button"></button>
</form>
<button id="btnDescargar2"></button>
<button id="btnPdf" type="button"></button>
<button id="btnImprimir" type="button"></button>
<button id="btnIA" type="button"></button>
<div id="zonaPrint" hidden></div>
`;

/** Monta el fixture (llamar antes del import dinámico del módulo bajo test). */
export function montarFixture(): void {
  document.body.innerHTML = FIXTURE_HTML;
}

/** Atajo getEl para tests (falla fuerte como el de la app). */
export function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`sin #${id} en el fixture`);
  return n as T;
}

/** Drop sintético con archivos (jsdom no trae un DataTransfer útil). */
export function eventoDrop(files: File[]): Event {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { files, types: ["Files"] } });
  return e;
}

/** Dragover sintético (con coords: el handler hace autoScroll). */
export function eventoDragover(types: string[] = ["Files"]): Event {
  const e = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { files: [], types } });
  Object.defineProperty(e, "clientX", { value: 10 });
  Object.defineProperty(e, "clientY", { value: 10 });
  return e;
}

/** Dragenter/dragleave sintéticos (llevan types como los DragEvent reales). */
export function eventoDragenter(types: string[] = ["Files"]): Event {
  const e = new Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { files: [], types } });
  return e;
}

export function eventoDragleave(types: string[] = ["Files"]): Event {
  const e = new Event("dragleave", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { files: [], types } });
  return e;
}

/** Paste sintético con archivos en el portapapeles. */
export function eventoPaste(files: File[]): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: { items: files.map((f) => ({ kind: "file", getAsFile: (): File => f })) },
  });
  return e;
}
