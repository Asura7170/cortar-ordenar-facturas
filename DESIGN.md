# DESIGN.md — Cortar y Ordenar Facturas (Diseño 1 · Libro Mayor)

## 0. Gobierno

- Dueño: quien toque `:root` o un componente en `src/styles/`.
- Regla atómica: todo PR que cambie un token o una regla visual actualiza este
  archivo o justifica por qué no. Sin esa línea, el PR no mergea.
- Relación: `AGENTS.md` manda (stack, Chrome-only, a11y); este archivo fija la
  identidad visual; `src/styles/*.css` es la implementación. Ante conflicto,
  vale el CSS vivo y se corrige aquí en el mismo PR.

## 1. Overview

App de escritorio para cortar fotos de facturas en comprobantes y ordenarlos en
hojas contables. Lenguaje: libro mayor en papel marfil, renglones verdes,
sellos de goma rojos, números tabulares. Tono: sobrio, auditado, confiable.
Principios: papel, no SaaS genérico; claridad sobre densidad; todo número
alinea a la derecha en tabular-nums.

## 2. Alcance

- Solo Chrome desktop. Sin responsive, sin mobile, sin fallbacks ni `@supports`.
- Dos temas vía `light-dark()` con `color-scheme: dark` por defecto y override
  `[data-tema="claro"]` en `:root`. Todo color nuevo entra en par claro/oscuro.

## 3. Colors

| Token                 | Light                | Dark      | Uso                                 |
| --------------------- | -------------------- | --------- | ----------------------------------- |
| `--papel`             | `#faf6ea`            | `#f4ecd8` | Fondo de hoja. No para fichas       |
| `--papel-brillo`      | `#fffdf6`            | `#fbf6e9` | Superficie elevada sobre papel      |
| `--papel-sombra`      | `#e6dcc0`            | `#e2d6b8` | Sombra/huella sobre papel           |
| `--tinta`             | `#2c3a28`            | `#22311f` | Texto principal sobre papel         |
| `--tinta-suave`       | `#55654f`            | `#4b5a47` | Texto secundario                    |
| `--tinta-fina`        | `#7f8f7a`            | `#7b8577` | Texto tenue, nunca para datos       |
| `--renglon`           | `#cfe3c6`            | `#b8cfae` | Renglón del libro contable          |
| `--renglon-fuerte`    | `#9ecb96`            | `#8fbf8a` | Renglón alto, foco, bordes activos  |
| `--sello`             | `#b23a2e`            | `#b23a2e` | Sello rojo: peligro, error, remover |
| `--sello-suave`       | `#e7c4bd`            | `#d8a29a` | Teñido de sello                     |
| `--verde-tinta`       | `#2f6b3a`            | `#2f6b3a` | Único acento de acción/ok           |
| `--verde-claro`       | `#eef4ea`            | `#eef4ea` | Fondo suave de acento               |
| `--mesa`              | `#eceadf`            | `#2e2b24` | Mesa bajo las hojas                 |
| `--mesa-oscura`       | `#e3e1d4`            | `#221f19` | Sombra de mesa (fondo canvas)       |
| `--panel`             | `#f6f2e5`            | `#3a352c` | Panel lateral                       |
| `--panel-claro`       | `#fdfaf0`            | `#463f34` | Hover de panel                      |
| `--texto-panel`       | `#2c3a28`            | `#f0ead9` | Texto sobre panel                   |
| `--texto-panel-suave` | `#57644f`            | `#c9c0a8` | Secundario sobre panel (~4.8:1 AA)  |
| `--monto-valor`       | `#2f6b3a`            | `#cfe6c2` | Cifra del total. Nunca otro verde   |
| `--aviso-motivo`      | `#b23a2e`            | `#e59a8d` | Motivo de aviso (AA ambos temas)    |
| `--input-bg`          | `#fffdf6`            | `#241f18` | Fondo de inputs                     |
| `--input-placeholder` | `#9aa48f`            | `#8d8672` | Placeholder                         |
| `--anillo`            | `renglon-fuerte 50%` | igual     | Anillo de `:focus-visible`          |

Resto por nombre (derivan de los de arriba vía `color-mix`/`var`):
`--borde-panel`, `--monto-bg`, `--dropzone-borde`, `--hover-claro`,
`--hover-ghost`, `--fondo-sheet-tag`, `--procesando-bg`, `--error-bg`,
`--error-cell-bg`, `--celda-remove`, `--footer-barra`, `--modal-*` (6),
`--gridopt-*` (4), `--ficha-activa`, `--layout-activo`, `--switch-bg`,
`--topbar-grad`.

## 4. Typography

- Familia única: `"Public Sans", "Segoe UI", Verdana, sans-serif` (`--serif` y
  `--mono` son el mismo stack). Vendoreada en `public/fonts` (400/600/700/800 +
  latin-ext, OFL, `font-display: swap`). Prohibida otra familia.
- Roles: brand 20px/700; monto total 22px/600 tabular; títulos de sección
  12-13px uppercase con tracking 0.1-0.14em; cuerpo 13-14px/1.5; datos
  (montos, códigos, badges) 11-12px mono con `tabular-nums`; dropzone
  24px/700 + icono 64px.
- `line-height` unitless salvo contextos fijos. Sin all-caps fuera de títulos.

## 5. Layout & Spacing

- Desktop fijo, escala base 8px. Canvas `24px 30px 60px`; hojas en columna
  con gap 30px; hoja `min(816px, 100%)` ratio 8.5/11; fila hoja+panel
  `min(1054px, 100%)` gap 14px; panel lateral 224px; dropzone `max-width 560px`.

## 6. Shapes & Elevation

- Radios: `--radio: 10px`, `--radio-s: 6px`; pill 20px (`.dz-fmt`); círculo
  (×); 4px celdas/hojas; 8px paneles/opciones.
- Sombras: `--sombra-hoja` (hoja y dropzone); `--anillo` solo en
  `:focus-visible`; `0 3px 8px rgba(0,0,0,.3)` botones; `0 12px 28px`
  fantasma de drag; modal `0 20px 60px`. Destino de drop: `inset 0 0 0 2px`
  verde u `outline` discontinuo, nunca sombra nueva.
- Hit-area 44px vía `::after` expandido (×, badge, girar); el visual queda chico.

## 7. Motion

- Solo `transform` y `opacity` (el fantasma de drag se mueve solo con
  transform). Excepción: esqueleto `skel-sweep` 1.2s linear infinite.
- Todo respeta `prefers-reduced-motion`. Transiciones 0.15s en hover.

## 8. Components

- `.monto-box/.monto-valor` (topbar.css, `#montoTotal`): cifra 22px/600 en
  `--monto-valor`; label 11px uppercase. Uso: solo lectura, un total por vista.
- `.panel` + `.switch` + `.codigo-row` (sidebar.css,
  `#chkCodigo/#chkOcr/#inputCodigo`): panel con head 12px uppercase; switch
  nativo con track; código con input numérico + rejilla de posición.
  Estados: `:checked/:disabled/:focus-visible` siempre definidos.
- `.sheet/.sheet-grid/.cell` (canvas.css, `#sheets`): hoja papel con renglones
  cada 34px; celda `empty` (discontinua) / con foto (`object-fit: contain`) /
  `drop-target` (inset verde). Hover revela × y girar; sin hover siempre
  visibles. Uso: renderiza `ui/sheets`, nunca construyas celdas a mano.
- `.grid-opt/.ficha/.layout-mini` (canvas.css, panel de hoja): ficha verde
  sobre grilla; `.active` marca borde + fondo. Uso: una distribución activa.
- `.cell-ocr-text` (canvas.css): `pre-wrap`, 12px/1.5, scroll propio; único
  lugar con texto seleccionable (`user-select: text`, el resto `none`).
- `.modal/.modal-card` (base.css, `#modalAjustes/#modalLimpiar`): `<dialog>`
  con `closedby`, backdrop, head/body/foot. Uso: `showModal()`, nunca divs.
- `.dropzone/.dropzone-grande` + `.btn-primary/.btn-ghost/.btn-danger`
  (canvas/base, `#dropzone/#fileInput`): punteado verde para subir; primario
  una acción por vista, danger solo destructivo.

## 9. Do's and Don'ts

1. Usa tokens, nunca hex/px literales; si falta uno, añádelo a `:root` en par
   claro/oscuro con motivo en el commit.
2. Reutiliza la clase y el id existentes; prohibido el componente paralelo.
3. Montos y códigos siempre `tabular-nums` y alineados a la derecha.
4. Todo interactivo con `:focus-visible` visible (anillo); sin excepciones.
5. Hit-area mínima 44px aunque el visual sea menor.
6. Un solo acento verde y un solo primario por vista.
7. Sin degradados, sin emojis, sin sombras nuevas, sin uppercase fuera de títulos.
8. Sin otra fuente que Public Sans; sin pesos fuera de 400/600/700/800.
9. Sin radios fuera de la escala (10/6/pill/círculo/4/8).
10. Texto OCR seleccionable solo en `.cell-ocr-text`; el resto `user-select: none`.
11. Print hereda el diseño; no rediseñes para imprimir.
12. Ante duda entre dos valores, elige el que ya existe en el CSS.

## 10. Mapa de archivos

- `:root` y base en `src/styles/base.css` (1/4) → topbar (2/4) → sidebar
  (3/4) → canvas (4/4); el orden de `<link>` en `index.html` es cascada.
- DOM contrato en `index.html` (41 ids); JS solo renderiza `#sheets`.
