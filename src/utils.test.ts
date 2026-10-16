/* Tests: sanear nunca deja "[object Object]" llegar al DOM; el canal #aviso
   apila toasts (error=alert/rojo, aviso=status/amarillo) con X, auto-cierre y
   despeje por grupo; tolera la ausencia del nodo. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MAX_TOASTS,
  avisar,
  avisarError,
  despejarToasts,
  esImportDinamicoMuerto,
  mostrarToasts,
  planificarToasts,
  sanear,
} from "./utils";
import type { ToastMensaje } from "./utils";

describe("sanear", () => {
  it('objetos/arrays → "" (nunca [object Object])', () => {
    expect(sanear({ a: 1 })).toBe("");
    expect(sanear(["12.5"])).toBe("");
    expect(sanear("a.png")).toBe("a.png");
    expect(sanear(42)).toBe("42");
    expect(sanear(null)).toBe("");
    expect(sanear(undefined)).toBe("");
  });
});

describe("esImportDinamicoMuerto (pestaña que cruza un deploy)", () => {
  it("detecta lo que Chrome grita por un chunk 404", () => {
    expect(
      esImportDinamicoMuerto(
        "Failed to fetch dynamically imported module: https://x/assets/ocr-abc.js",
      ),
    ).toBe(true);
    expect(esImportDinamicoMuerto("Importing a module script failed.")).toBe(true);
    expect(esImportDinamicoMuerto("Failed to load dynamic import /ort/ort-wasm...mjs")).toBe(true);
  });

  it("confunde otros fallos: fetch de red, 404 de modelo, timeout EP", () => {
    expect(esImportDinamicoMuerto("modelo: HTTP 429 en https://hf...")).toBe(false);
    expect(esImportDinamicoMuerto("timeout tras 30000ms")).toBe(false);
    expect(esImportDinamicoMuerto("ORTH sin proveedor válido")).toBe(false);
  });
});

describe("canal #aviso (pila de toasts)", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="aviso" role="region" aria-label="Avisos"></div>';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("apila un toast por mensaje (no reemplaza) con su rol", () => {
    mostrarToasts([
      {
        tipo: "error",
        titulo: "Formato no soportado",
        detalle: "usá JPG, PNG, WEBP o PDF",
        archivo: "a.txt",
        grupo: "intake",
      },
      {
        tipo: "error",
        titulo: "PDF demasiado largo",
        detalle: "tiene más de 10 páginas",
        archivo: "b.pdf",
        grupo: "intake",
      },
    ]);
    const toasts = document.querySelectorAll("#aviso > .toast");
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.classList.contains("toast-error")).toBe(true);
    expect(toasts[1]?.classList.contains("toast-error")).toBe(true);
    // Cada error anuncia por sí (assertivo), sin relatar la historia completa.
    for (const t of toasts) expect(t.getAttribute("role")).toBe("alert");
  });

  it("estructura: título, detalle con archivo el último, y title completo", () => {
    mostrarToasts([
      {
        tipo: "error",
        titulo: "Formato no soportado",
        detalle: "usá JPG, PNG, WEBP o PDF",
        archivo: "nota.txt",
        grupo: "intake",
      },
    ]);
    const toast = document.querySelector<HTMLElement>("#aviso > .toast-error");
    expect(toast?.dataset.grupo).toBe("intake");
    expect(toast?.querySelector(".toast-titulo")?.textContent).toBe("Formato no soportado");
    expect(toast?.querySelector(".toast-detalle")?.textContent).toBe(
      "usá JPG, PNG, WEBP o PDF · nota.txt",
    );
    expect(toast?.querySelector(".toast-archivo")?.getAttribute("title")).toBe("nota.txt");
  });

  it("singleton (sin grupo) reemplaza al general anterior en el acto", () => {
    avisarError("No se pudo abrir el recorte.");
    avisarError("No se pudo copiar el texto.");
    expect(document.querySelectorAll("#aviso > .toast")).toHaveLength(1);
    expect(document.querySelector("#aviso .toast-titulo")?.textContent).toBe(
      "No se pudo copiar el texto.",
    );
  });

  it("el X cierra con fade y el nodo se retira al terminar la salida", async () => {
    avisarError("fallo de prueba");
    const toast = document.querySelector("#aviso > .toast");
    toast?.querySelector<HTMLButtonElement>(".toast-cerrar")?.click();
    expect(toast?.classList.contains("saliendo")).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector("#aviso > .toast")).toBeNull();
  });

  it("auto-cierre: el aviso expira a los 5s", async () => {
    avisar("aviso corto");
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelectorAll("#aviso > .toast.saliendo")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector("#aviso > .toast")).toBeNull();
  });

  it("auto-cierre: el error expira a los 8s (más margen de lectura)", async () => {
    avisarError("error con más margen de lectura");
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.querySelectorAll("#aviso > .toast.saliendo")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelectorAll("#aviso > .toast.saliendo")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelector("#aviso > .toast")).toBeNull();
  });

  it("el hover pausa el auto-cierre y retoma al salir", async () => {
    avisarError("error pausado");
    const toast = document.querySelector("#aviso > .toast");
    toast?.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.advanceTimersByTimeAsync(7900);
    expect(toast?.classList.contains("saliendo")).toBe(false);
    toast?.dispatchEvent(new MouseEvent("mouseleave"));
    await vi.advanceTimersByTimeAsync(7900); // 8s de vida desde que retomó = 8.7 total
    expect(toast?.classList.contains("saliendo")).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(toast?.classList.contains("saliendo")).toBe(true);
  });

  it("despejarToasts cierra solo su grupo (con fade)", () => {
    mostrarToasts([
      { tipo: "error", titulo: "rechazo", archivo: "a.txt", grupo: "intake" },
      { tipo: "aviso", titulo: "conteo general" },
    ]);
    despejarToasts("intake");
    const saliendo = document.querySelectorAll<HTMLElement>("#aviso > .toast.saliendo");
    expect(saliendo).toHaveLength(1);
    expect(saliendo[0]?.dataset.grupo).toBe("intake");
    expect(document.querySelectorAll("#aviso > .toast:not(.saliendo)")).toHaveLength(1);
  });

  it("mostrarToasts respeta el cap del stack: el más viejo hace lugar", async () => {
    const rechazos: ToastMensaje[] = [
      { tipo: "error", titulo: "t1", archivo: "a1.txt", grupo: "intake" },
      { tipo: "error", titulo: "t2", archivo: "a2.txt", grupo: "intake" },
      { tipo: "error", titulo: "t3", archivo: "a3.txt", grupo: "intake" },
      { tipo: "error", titulo: "t4", archivo: "a4.txt", grupo: "intake" },
      { tipo: "error", titulo: "t5", archivo: "a5.txt", grupo: "intake" },
    ];
    mostrarToasts(rechazos);
    expect(document.querySelectorAll("#aviso > .toast:not(.saliendo)")).toHaveLength(MAX_TOASTS);
    expect(document.querySelector("#aviso > .toast.saliendo")).toBeNull();
    mostrarToasts([{ tipo: "error", titulo: "t6", archivo: "a6.txt", grupo: "intake" }]);
    // t1 queda saliendo (fade) y, al terminar su salida, el stack sigue en 4.
    expect(document.querySelector("#aviso > .toast.saliendo .toast-titulo")?.textContent).toBe(
      "t1",
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(document.querySelectorAll("#aviso > .toast:not(.saliendo)")).toHaveLength(MAX_TOASTS);
  });

  it("sin #aviso no lanza", () => {
    document.body.innerHTML = "";
    expect(() =>
      mostrarToasts([{ tipo: "error", titulo: "x", archivo: "x.txt", grupo: "intake" }]),
    ).not.toThrow();
    expect(() => despejarToasts("intake")).not.toThrow();
  });
});

describe("planificarToasts (cap del lote, puro)", () => {
  it(">4 rechazos: 3 individuales + resumen «…y N más descartados»", () => {
    const rechazos: ToastMensaje[] = Array.from({ length: 6 }, (_v, i): ToastMensaje => {
      const n = String(i);
      return { tipo: "error", titulo: `t${n}`, archivo: `a${n}.txt`, grupo: "intake" };
    });
    const plan = planificarToasts(rechazos);
    expect(plan).toHaveLength(4);
    expect(plan[3]?.titulo).toBe("…y 3 más descartados");
    expect(plan[3]?.grupo).toBe("intake");
    expect(plan[3]?.archivo).toBeUndefined();
  });

  it("≤4 no colapsa y lote singleton no hereda grupo", () => {
    const tres: ToastMensaje[] = [{ tipo: "aviso", titulo: "conteo" }];
    expect(planificarToasts(tres)).toEqual(tres);
    const cinco: ToastMensaje[] = Array.from({ length: 5 }, (_v, i): ToastMensaje => {
      const n = String(i);
      return { tipo: "error", titulo: `t${n}` };
    });
    const plan = planificarToasts(cinco);
    expect(plan).toHaveLength(4);
    expect(plan[3]?.titulo).toBe("…y 2 más descartados");
    expect(plan[3]?.grupo).toBeUndefined();
  });
});
