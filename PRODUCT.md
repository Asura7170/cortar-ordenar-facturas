# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript + Vite (dev server `npm run dev --open`, build a `dist/`). Frontend-only, sin backend. Chrome-only. OCR con PaddleOCR PP-OCRv6_small (SDK `@paddleocr/paddleocr-js`), recorte con OpenCV.js, export .docx con docx.js, PDF con pdf.js.

## Users

Dueño / emprendedor que junta comprobantes y facturas de su negocio o gastos personales. Trabaja en sesiones de lote mediano (10–50 comprobantes). No es especialista: valora que todo se entienda sin curva de aprendizaje, que el monto sea confiable y que el resultado sea entregable sin retoques.

## Product Purpose

Convertir fotos/PDFs de comprobantes en un lote ordenado de comprobantes recortados dentro de hojas carta listas para descargar como .docx, con el monto total acumulado a la vista. Éxito: el usuario pega/arrastra fotos, la app recorta + OCR + suma, y descarga un Word ordenado sin tener que tocar una herramienta de edición.

## Positioning

Todo el pipeline (recorte, OCR, suma, maquetado Word) corre en el navegador, sin subir información a servidores propios. El usuario no edita nada: pega, ordena lo que quiere y descarga. El monto se extrae por comprobante (1 TOTAL) con ayuda de un LLM openai-compatible configurable, con fallback a monto manual por tarjeta.

## Operating Context

Sesiones en escritorio (Chrome), abrir/pegar fotos o PDFs con Ctrl+V desde portapapeles, arrastrar archivos o clic en dropzone. El flujo es por cola con estado por ítem (procesando/OK/error), el usuario puede reordenar con arrastre libre tipo Word dentro de cada hoja carta (posición física, no cambia el orden de inserción). El .docx va al archivo propio (control, reembolsos, auditoría interna): el orden formal del lote importa, pero no hay un contador externo obligado. Se espera una herramienta de oficina ejecutiva: sobria, precisa, confiable, sin gamificación.

## Capabilities and Constraints

- Entrada: imágenes (jpg/png/webp/bmp/gif) + PDF multipágina (cada página = comprobante); HEIC → aviso formato no soportado, no rompe la cola.
- Recorte OpenCV.js con fallback a imagen completa si no hay contorno; EXIF respetado; resize automática (>2000px lado mayor).
- OCR PaddleOCR PP-OCRv6_small (`lang: latin`, worker), cola secuencial FIFO.
- Monto: 1 TOTAL por comprobante; suma exacta en cents; badge por comprobante + total; moneda configurable (default USD, formato US `1,234.56`); LLM sin TOTAL → campo manual en tarjeta (sí suma).
- Código de pedido: check on/off + longitud N (solo dígitos), ambos persisten en localStorage; footer derecho en todas las hojas del .docx; check activo con < N dígitos → bloquea descarga con mensaje.
- Grilla: carta N-up default 4 (1–6), hojas blancas sobre fondo gris, scroll vertical, ajuste al ancho; arrastre libre por hoja; X elimina comprobante completo.
- Limpiar borra comprobantes/montos/OCR; conserva check, N y configuración IA/moneda.
- OCR modal: solo lectura + copiar, select por comprobante.
- IA: modal ajustes (baseURL, apiKey en localStorage, model por defecto `gpt-4o-mini`); sin config → monto manual; la key nunca va al repo.
- UI en español neutro. Nombre visible: "Cortar y Ordenar Facturas".

## Brand Commitments

- Nombre visible: "Cortar y Ordenar Facturas".
- Ánimo: herramienta de oficina ejecutiva — sobria, precisa, confiable.
- Hojas carta blancas sobre gris (como Word).

## Evidence on Hand

Ninguna: no hay assets, capturas ni datos de demostración reales. No inventar claims comerciales. Las imágenes de demostración son sintéticas y etiquetadas como tales.

## Product Principles

1. Cero edición manual: pegar → ordenar → descargar. La app hace el trabajo pesado.
2. Estado siempre visible: cada comprobante dice si va bien (procesando/OK/error) y cuánto aporta al total.
3. Confianza en el monto: suma exacta en cents, con fallback claro (monto manual) cuando el LLM no encuentra TOTAL.
4. Un clic para lo frecuente, máximo dos para lo demás: todo accesible sin navegar menús.
5. El lote vive en hojas reales: la vista previa carta es la fuente de verdad de lo que sale en Word.

## Accessibility & Inclusion

Usuario en escritorio Chrome; sin requisitos de accesibilidad específicos confirmados. Mantener estándar de la plataforma (semántica, contraste, foco, teclado) sin requisitos especiales conocidos.
