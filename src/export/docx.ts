/* Export .docx — STUB con valores de ejemplo.
   La implementación real (docx.js: hojas N-up, EMU, wrap SQUARE, footer)
   vivirá acá; la firma descargarWord() y el nombre de archivo ya son finales. */
import { state } from '../state';
import { aplanar, formatearMoneda, totalItems } from '../ui/monto';
import { getEl } from '../utils';

const btnDescargar: HTMLButtonElement = getEl<HTMLButtonElement>('btnDescargar2');

export function codigoValido(): boolean {
  if (!state.codigoActivo) return true;
  return state.codigoValor.length === state.codigoLongitud && /^\d+$/.test(state.codigoValor);
}

export function nombreArchivo(): string {
  const cod = state.codigoActivo ? state.codigoValor : 'sincodigo';
  return `${cod}-comprobante.docx`;
}

export async function descargarWord(): Promise<void> {
  if (!codigoValido()) return;
  if (totalItems() === 0) return;

  const contenido = [
    'DOCX STUB — Cortar y Ordenar Facturas',
    `Código de pedido: ${state.codigoActivo ? state.codigoValor : '(sin código)'}`,
    `Hojas: ${state.hojas.length}`,
    ...aplanar().map((c) => `- ${c.nombre}: ${formatearMoneda(c.montoCents ?? 0)}`),
  ].join('\n');
  const blob = new Blob([contenido], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombreArchivo();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function initExport(): void {
  btnDescargar.addEventListener('click', () => { void descargarWord(); });
}
