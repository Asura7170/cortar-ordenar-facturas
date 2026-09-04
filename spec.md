# Especificación — Cortar y Ordenar Facturas

App frontend-only, Chrome-only. TypeScript + Vite (dev server con `--open` y build de producción). Sin backend.

## Resumen

Pegar/subir/arrastrar imágenes y PDFs → recorte con OpenCV.js → OCR con PaddleOCR (PP-OCRv6_small) → extracción de TOTAL con LLM openai-compatible (o monto manual) → grilla carta N-up (default 4, arrastre libre tipo Word) → exportar .docx con footer derecho (código de pedido).

## Estructura / esqueleto

```
facturas/
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts          # COOP/COEP, server.open, build → dist/
├─ .gitignore
├─ spec.md
└─ src/
   ├─ main.ts              # bootstrap app
   ├─ types.ts             # Comprobante, Estado, Config, OcrResult...
   ├─ state.ts             # estado global + persistencia (check, N, moneda, IA)
   ├─ ui/
   │  ├─ layout.ts         # esqueleto pantalla (header, monto, main, sidebar)
   │  ├─ sidebar.ts        # dropzone (arrastrar/clic/pegar), ordenar N, +OCR, limpiar, descargar
   │  ├─ sheets.ts         # render hojas carta, grilla N-up, drag & drop libre, scroll
   │  ├─ monto.ts          # badge por comprobante + suma total (cents exactos)
   │  ├─ ocrModal.ts       # ventana flotante texto OCR (solo lectura + copiar)
   │  └─ settingsModal.ts  # endpoint, model, apiKey, moneda
   ├─ pipeline/
   │  ├─ crop.ts           # OpenCV.js: grayscale→blur→Canny→contours→warp, fallback full
   │  ├─ ocr.ts            # PaddleOCR.create({ocrVersion:'PP-OCRv6', lang:'latin', worker:true})
   │  ├─ pdf.ts            # pdf.js → cada página a ImageBitmap (200dpi, JPEG .85, tope res)
   │  ├─ extract.ts        # LLM openai-compatible: texto OCR → {total, currency}
   │  └─ queue.ts          # cola secuencial FIFO, estado por item (procesando/OK/error)
   └─ export/
      ├─ docx.ts           # docx.js: N hojas, imágenes flotantes (EMU página, wrap SQUARE), footer
      └─ filename.ts       # {codigo}-comprobante.docx
```

## Decisiones (AC)

- **Código pedido:** check on/off + input N (solo dígitos), ambos persisten en localStorage; footer derecho en todas las hojas del .docx; check activo con < N dígitos → bloquear descarga con mensaje.
- **Monto:** 1 TOTAL por comprobante; suma exacta en cents (sin float); badge por comprobante + total; moneda configurable (default USD, formato US `1,234.56`); LLM sin TOTAL → campo manual en tarjeta (sí suma).
- **Limpiar:** borra comprobantes, montos y textos OCR; conserva check, N, y configuración IA/moneda.
- **Errores:** continuar + estado por item; el monto suma solo los OK; el resto se procesa.
- **Formato de entrada:** imágenes + PDF multipágina (cada página = comprobante, raster todas, sin omitir blancas); HEIC → aviso "formato no soportado", no falla la cola.
- **EXIF:** createImageBitmap con orientación respetada; redimensionar automática si > 2000px lado mayor.
- **Grilla:** N por hoja default 4; arrastre libre dentro de la hoja (posiciones % página, z-order), NO cambia el orden de inserción; X elimina comprobante completo; scroll vertical, hojas ajustadas al ancho.
- **OCR modal:** solo lectura, select por comprobante, botón copiar; texto usado solo por el LLM.
- **IA:** modal ajustes (baseURL, apiKey en localStorage, model por defecto gpt-4o-mini); sin config → monto manual; nunca expone la key en el repo.
- **Word:** docx.js estándar OOXML; imágenes flotantes con posición absoluta en EMU relativa a página + wrap SQUARE; footer derecho en todas las hojas; un solo archivo `{codigo}-comprobante.docx`; validar en Word y LibreOffice.
- **Dev/Prod:** `npm run dev --open` (Vite dev server, COOP/COEP en vite.config para WASM threads); `npm run build` → `dist/` para producción.

## Diagrama de flujo (mermaid)

```mermaid
flowchart TD
    A["Pegar / Subir / Arrastrar / Ctrl+V"] --> B{"¿Formato válido?<br/>jpg · png · webp · bmp · gif · pdf"}
    B -- "No (incl. HEIC)" --> B1["Aviso: formato no soportado"]
    B -- "Sí" --> C{"¿PDF o imagen?"}
    C -- "PDF" --> D["pdf.js → rasterizar cada página<br/>200 dpi · JPEG q0.85 · tope resolución"]
    C -- "Imagen" --> E["createImageBitmap + EXIF<br/>resize si > 2000px"]
    D --> F["Cola secuencial FIFO<br/>estado por item: procesando/OK/error"]
    E --> F
    F --> G["OpenCV.js crop<br/>grayscale → blur → Canny → contours<br/>approxPolyDP 4 pts → warp"]
    G --> H{"¿Contorno detectado?"}
    H -- "No (papel llena frame)" --> I["Imagen completa, sin recortar"]
    H -- "Sí" --> J["Imagen recortada"]
    I --> K["PaddleOCR PP-OCRv6_small<br/>worker · lang latin"]
    J --> K
    K --> L["Texto OCR"]
    L --> M{"¿IA openai-compatible configurada?"}
    M -- "No" --> N["Monto manual en tarjeta"]
    M -- "Sí" --> O["LLM: texto OCR → {total, moneda}"]
    O -- "Sin TOTAL / error" --> N
    O -- "Total" --> P["Suma exacta en cents<br/>badge por comprobante + total"]
    N --> Q["Inserción en hoja carta N-up<br/>default 4 por hoja · scroll vertical"]
    P --> Q
    Q --> R["Arrastre libre por hoja<br/>posiciones % página · orden estable"]
    R --> S["Botón Descargar Word"]
    S --> T{"Check activo y<br/>N dígitos completos?"}
    T -- "No" --> T1["Bloquear descarga + mensaje"]
    T -- "Sí" --> U["docx.js: N hojas · imágenes flotantes<br/>EMU página + wrap SQUARE · footer derecho<br/>todas las hojas · {codigo}-comprobante.docx"]
    B1 --> F
```
