# 🎯 Regla obligatoria de la app (Cortar y Ordenar Facturas)

## Chrome-first — sin retrocompatibilidad, sin mobile

- Esta página está diseñada **únicamente para Chrome (Chromium)** y navegadores basados en Chromium (Brave, Edge, Opera, Arc) **en desktop**.
- **NUNCA** optimizar, arreglar ni tomar en cuenta la retrocompatibilidad con Firefox, Safari, o cualquier navegador no-Chromium.
- **NUNCA** considerar responsive ni tamaños pequeños (celulares, tablets, etc.). Solo desktop.
- Se pueden usar **sin preguntar y sin duda alguna** los elementos, funciones, propiedades, atributos y features más modernas y experimentales — **siempre que estén disponibles en Chrome/Chromium** (ej: `<dialog closedby>`, Invoker Commands `command`/`commandfor`, Popover API, CSS `:has()`, `color-scheme`, nesting, etc.).
- **No** escribir fallbacks, polyfills, `@supports`, prefijos de vendor ni comentarios de compatibilidad para navegadores no-Chromium. Si algo no está en Chrome, no se usa.

## Cómo correr la app

```bash
# Vite (recomendado) — abre en el navegador por defecto
npm run dev

# Alternativa estática
python -m http.server 8000
# → http://localhost:8000
```

---

# AGENTS.md — Errores y Soluciones: Firecrawl CLI + TinyFish CLI

Diagnóstico de las causas raíz de los errores recurrentes al usar **Firecrawl** y **TinyFish** en este entorno (Windows + cmd), con soluciones directas.

---

## 🧰 Tools y sus comandos base

- **Firecrawl**: `firecrawl search|scrape|map|crawl|parse|credit-usage`
- **TinyFish**: `tinyfish search query|fetch content get|agent run|browser session create`

---

## ❌ Error 1: `(no output)` al usar Firecrawl con `-o`

**Causa raíz:** Con `-o <archivo>`, Firecrawl **escribe el resultado en el archivo y NO imprime nada en stdout**. El comando sale con `exit 0` pero sin texto, por eso parece que "falló". No es un error real.

**Solución:** Verifica la existencia del archivo y lee su contenido con un lector de archivos o `node`/`grep`; NO esperes output en stdout.

```bash
# Comando (sin output en consola, pero sí crea el archivo)
firecrawl search "query" -o .firecrawl/result.json --json

# 1. Confirmar que existe
dir .firecrawl\result.json

# 2. Leer el JSON (NO confiar en stdout del comando)
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('.firecrawl/result.json','utf8'));console.log(JSON.stringify(d,null,2).slice(0,3000))"

# 3. O extraer solo URLs/títulos
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('.firecrawl/result.json','utf8'));(d.data.web||[]).forEach(r=>console.log('- '+r.title+' | '+r.url));"
```

**Regla general:** cualquier herramienta que escriba a un archivo con `-o` → leer el archivo después; el stdout es invisible.

---

## ❌ Error 2: `Exit code: 1` con `{"error":"Search service unavailable","status":503}` (TinyFish search)

**Causa raíz:** El **servicio de búsqueda backend de TinyFish está caído/sobrecargado** (503). NO es un problema de autenticación: `tinyfish doctor` pasa `Authenticated call: pass` y `fetch` funciona (`fetch content get` sí devuelve resultados).

**Solución:**
1. **No asumir que es un error de configuración** — `doctor` confirma credenciales OK.
2. **Usar `fetch` en su lugar** (el GET de contenido funciona aunque el search no).
3. **Fallback a Firecrawl `search`** para descubrir URLs, y `fetch`/`scrape` para leer contenido.

```bash
# Opción A: reintentar después (fallo transitorio)
tinyfish search query "query" --pretty

# Opción B: usar fetch directo si ya tienes URLs
tinyfish fetch content get --format markdown "https://example.com"

# Opción C: fallback a Firecrawl search (recomendado cuando tinyfish search está 503)
firecrawl search "query" --limit 8 -o .firecrawl/result.json --json
# luego leer el archivo (ver Error 1)
```

---

## ❌ Error 3: `error: unknown option '--engine'` (TinyFish)

**Causa raíz:** El CLI de TinyFish **no tiene la opción `--engine`** (ni otros flags que no estén en su `--help`). El motor de búsqueda no es configurable.

**Solución:** `tinyfish search query --help` para ver las opciones válidas. Opciones reales: `--location`, `--language`, `--include-domains`, `--exclude-domains`, `--page`, `--pretty`. **NO existe `--engine` ni `--sources` ni `--categories`** (eso es de Firecrawl).

```bash
# Válido
tinyfish search query "query" --pretty --include-domains developer.mozilla.org

# NO usar
tinyfish search query "query" --engine google
```

---

## ❌ Error 4: `--debug` como flag de subcomando falla

**Causa raíz:** `--debug` es una **opción del comando raíz** (`tinyfish --debug`), no de `search`/`fetch`. `tinyfish search query "x" --debug` → "unknown option".

**Solución:** Colocar `--debug` al inicio, o usar `TINYFISH_DEBUG=1` como variable de entorno.

```bash
tinyfish --debug search query "query" --pretty
# o
set TINYFISH_DEBUG=1
tinyfish search query "query" --pretty
```

---

## ❌ Error 5: `"new-item" no se reconoce` / `mkdir .firecrawl\path` falla silencioso

**Causa raíz:** El shell por defecto es **`cmd` (Windows)**, no PowerShell. `new-item` es de PowerShell; en cmd hay que usar `mkdir`. Además, si la ruta ya existe, `mkdir` falla pero no rompe el pipeline.

**Solución:** Usar `mkdir` (cmd) o `if not exist ... mkdir`. `new-item` solo funciona si ejecutas con `powershell -Command`.

```bash
# En cmd (shell default)
mkdir .firecrawl\carpeta 2>nul & firecrawl scrape "https://url" -o .firecrawl\out.md

# O si necesitas PowerShell
powershell -Command "New-Item -ItemType Directory -Force -Path .firecrawl\carpeta | Out-Null"
```

---

## ❌ Error 6: `node: Cannot find module 'extract.js'` (scripts de extracción)

**Causa raíz:** El script `extract.js` estaba en el **scratchpad del agente** (`C:\Users\kevin\AppData\Local\Temp\commandcode\...\scratchpad`), no en el cwd del proyecto. `node extract.js` busca en el cwd y no lo encuentra.

**Solución:** Usar la **ruta absoluta** al script, o un script inline con `node -e`.

```bash
# Con ruta absoluta al scratchpad
node "C:\Users\kevin\AppData\Local\Temp\commandcode\C--Users-kevin-Downloads-...\scratchpad\extract.js" result.json

# O inline (recomendado para una sola extracción)
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('.firecrawl/result.json','utf8'));(d.data.web||[]).forEach(r=>console.log(r.title))"
```

---

## ❌ Error 7: Scrape `--wait-for` con `--only-main-content` omite contenido de demos/iframes

**Causa raíz:** Páginas con **demos embebidas (CodePen/iframe) o JS renderizado** necesitan espera. `--only-main-content` limpia el contenido principal, pero puede omitir secciones dentro de iframes/demos.

**Solución:** Usar `--wait-for` con un valor real (3000+), `--only-main-content` solo si el contenido estático es suficiente; si falta, scrapear en 2 fases (una con `--only-main-content`, otra sin él) o usar `--query` para preguntar al documento.

```bash
# Con espera para JS
firecrawl scrape "https://page" --wait-for 3000 -o .firecrawl/page.md

# Sin only-main-content si el contenido está en demos/iframes
firecrawl scrape "https://page" --wait-for 5000 --no-only-main-content -o .firecrawl/page.md
```

---

## ✅ Buenas prácticas (evitar estos errores desde el inicio)

1. **Firecrawl con `-o`** → leer el archivo después (el stdout está vacío a propósito).
2. **Comprobar `--help` antes de usar flags** → evitar `unknown option` (cada CLI tiene opciones distintas).
3. **Leer JSON con `node -e`** → no depender de `findstr`/`grep` para extraer campos de JSON en Windows (el formato de `grep` de Oniguruma rechaza patrones con corchetes sin escapar).
4. **Usar `tinyfish fetch` como fallback** cuando `search` da 503 → el fetch funciona independientemente.
5. **Respetar la limitación por comando** → no usar `--engine`/`--sources`/`--categories` con TinyFish (son de Firecrawl); usar `--include-domains` con TinyFish.
6. **Rutas absolutas a scripts** → los scripts auxiliares viven en el scratchpad; usar la ruta completa o `node -e` inline.

---

## 🔍 Comprobación rápida del estado

```bash
# Firecrawl: estado, auth, créditos
firecrawl --status

# TinyFish: diagnóstico de auth y conectividad
tinyfish doctor

# TinyFish: si search está caído (503), fetch sigue disponible
tinyfish fetch content get --format markdown "https://example.com"
```

**Resumen:** el error más común (`(no output)` + `Exit code: 1`) NO es un fallo real de Firecrawl: es el patrón `-o` (script → archivo) + `tinyfish search` 503 del servicio + flags incompatibles. Leer el archivo y verificar `--help` resuelve la mayoría de los casos.
