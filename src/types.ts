/* ============================================================
   Tipos de dominio — Cortar y Ordenar Facturas (Diseño 1 · Libro Mayor)
   Solo tipos e interfaces: 100% erasable (tsc --erasableSyntaxOnly).
   Sin enums, namespaces ni parameter properties.
   ============================================================ */

/** Monedas soportadas (ver MONEDAS en state). */
export type Moneda = "USD" | "ARS" | "EUR" | "BOB";

/** Estado del pipeline por comprobante. `error` reservado para el pipeline real. */
export type EstadoComprobante = "pendiente" | "procesando" | "ok" | "error";

/** Ids de plantilla en el orden de presentación del panel. */
export type LayoutId =
  | "u1"
  | "u2h"
  | "u2v"
  | "u3h"
  | "u3v"
  | "u3m"
  | "u4x2"
  | "u5m"
  | "u6x2"
  | "u6m";

/** Posición [fila, columna, span] dentro del grid de la hoja. */
export type PlantillaPos = readonly [fila: number, col: number, span: number];

/** Plantilla de distribución N-up de una hoja. */
export interface Plantilla {
  readonly total: number;
  readonly filas: number;
  readonly cols: number;
  readonly pos: readonly PlantillaPos[];
}

// ponytail: Cents es number plano; branded si el pipeline real necesita distinguirlo.
export type Cents = number;

/** Comprobante individual (una casilla ocupada). */
export interface Comprobante {
  readonly id: number;
  readonly nombre: string;
  /** Blob URL de la imagen original (revocar con URL.revokeObjectURL al quitar). */
  readonly imgUrl: string;
  /** Miniatura WebP o null (→ esqueleto) hasta que se genere (PDF: portada o null). */
  thumbUrl: string | null;
  /** Texto OCR (mock de ejemplo hasta integrar PaddleOCR). */
  textoOcr: string;
  /** Total en cents o null si aún no se extrajo. */
  montoCents: Cents | null;
  readonly moneda: Moneda;
  estado: EstadoComprobante;
  readonly posicion: number;
  readonly file?: File;
}

/** Hoja carta con casillas fijas (una por posición de la plantilla). */
export interface Hoja {
  readonly id: number;
  layout: LayoutId;
  slots: (Comprobante | null)[];
}

/** Config del LLM openai-compatible (futura extracción del TOTAL). */
export interface ConfigIA {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Estado global mutable de la app (ver src/state.ts). */
export interface EstadoApp {
  hojas: Hoja[];
  codigoActivo: boolean;
  codigoLongitud: number;
  codigoValor: string;
  configIA: ConfigIA;
  moneda: Moneda;
  colaEnProceso: boolean;
  modoOcr: boolean;
}

/** Subset persistido en localStorage (clave `libro-mayor-state`); cada ventana guarda solo lo suyo. */
export type PersistedState = Partial<
  Pick<EstadoApp, "codigoActivo" | "codigoLongitud" | "codigoValor" | "moneda" | "configIA">
>;

// ponytail: OcrResult/ExtractResult borrados (0 usos); vuelven con el pipeline real.
