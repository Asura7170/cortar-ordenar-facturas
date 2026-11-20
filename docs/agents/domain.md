# Domain Docs

Cómo consumen los skills la documentación de dominio de este repo.

## Antes de explorar

- **`GLOSSARY.md`** en la raíz del repo, si existe.
- **`docs/adr/`**: leer los ADR que toquen el área en la que se va a trabajar.
- Si estos archivos no existen, **seguir en silencio**: no marcarlo como faltante ni sugerir crearlos. `/domain-modeling` los crea cuando un término o una decisión real queda resuelta.

## Layout

Single-context: `GLOSSARY.md` + `docs/adr/` en la raíz. No hay contextos por paquete ni `GLOSSARY-MAP.md`.

```
/
├── GLOSSARY.md          (se crea on-demand)
├── docs/
│   ├── adr/             (se versiona)
│   └── agents/          (se versiona)
└── src/
```

## Uso

- Nombrar conceptos con el vocabulario del glosario: comprobante, hoja, cola, OCR, monto en cents, slot.
- Si un output contradice un ADR, decirlo explícitamente en vez de pisarlo.
- Si falta un concepto que el proyecto ya usa, es señal de gap: anotarlo para `/domain-modeling`, no inventar sinónimos.
