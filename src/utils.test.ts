/* Tests: sanear nunca deja "[object Object]" llegar al DOM; avisarError
   pinta span.motivo en #aviso (y tolera su ausencia). */
import { describe, expect, it } from "vite-plus/test";
import { avisarError, sanear } from "./utils";

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

describe("avisarError", () => {
  it("pinta span.motivo dentro de #aviso (reemplaza el anterior)", () => {
    document.body.innerHTML = '<p class="hint hint-canvas" id="aviso" role="status"></p>';
    avisarError("El recorte es demasiado pequeño.");
    const span = document.querySelector("#aviso > span.motivo");
    expect(span?.textContent).toBe("El recorte es demasiado pequeño.");
    // Segunda llamada sobrescribe (mismo contrato que el avisar anterior).
    avisarError("No se pudo recortar la imagen.");
    expect(document.querySelectorAll("#aviso > span.motivo")).toHaveLength(1);
    expect(document.getElementById("aviso")?.textContent).toBe("No se pudo recortar la imagen.");
  });

  it("sin #aviso no lanza", () => {
    document.body.innerHTML = "";
    expect(() => avisarError("x")).not.toThrow();
  });
});
