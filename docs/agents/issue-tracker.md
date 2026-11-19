# Issue tracker: markdown local

Issues y specs viven como archivos markdown en `docs/<feature>/` (scratch local, gitignored). No usar `agents/` ni `adr/` como feature slug: son carpetas reservadas.

## Convenciones

- Un feature por carpeta: `docs/<feature-slug>/`.
- Spec: `docs/<feature-slug>/spec.md`.
- Ticket: `docs/<feature-slug>/issues/<NN>-<slug>.md`, numerado desde `01`; nunca un archivo combinado.
- Estado de triage: `**Estado:** <rol>` cerca del inicio (ver `triage-labels.md`).
- Categoría: `**Categoría:** bug|enhancement`.
- Bloqueo: `**Bloqueado por:** NN, NN`; sin bloqueo, `Ninguno (puede empezar ya)`.
- Claim: `**Asignado:** <usuario>`.
- Comentarios e historial: al final, bajo `## Comments`.
- Cerrado: agregar `**Cerrado:** <fecha>`. Un ticket cerrado no entra al frontier.

## Operaciones

- **Crear:** escribir el archivo del ticket.
- **Leer:** leer el archivo; si hay `## Comments`, incluirlos.
- **Listar:** `Get-ChildItem docs/*/issues/*.md` y filtrar por `**Estado:**` y `**Cerrado:**`.
- **Etiquetar:** editar la línea `**Estado:**`.
- **Cerrar:** agregar `**Cerrado:** <fecha>`; si es rechazo, `**Estado:** wontfix`.
- **Comentar:** agregar el bloque bajo `## Comments`.
- **Wayfinding:** mapa en `docs/<effort>/map.md`; tickets hijos en `issues/`; frontier = archivo sin `**Cerrado:**`, sin bloqueos abiertos y sin `**Asignado:**`.

## Ejemplo

Los 10 tickets de `docs/ultracite-cleanup/issues/` ya usan `**Estado:** ready-for-agent` y `**Bloqueado por:**`; la categoría se agrega cuando se triageen.
