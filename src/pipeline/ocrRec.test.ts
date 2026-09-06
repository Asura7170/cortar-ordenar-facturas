/* Tests: ocrRec — normalización de línea, matriz afín y CTC greedy
   (puros; el lienzo solo lo toca ocr.ts). */
import { describe, expect, it } from "vite-plus/test";
import { decodificarCtc, matrizAfin, normalizarLinea, REC_ALTO } from "./ocrRec";
import { DICT_OCR } from "./ocrDict";

describe("normalizarLinea", () => {
  it("blanco 4x2 → unos en lo útil y ceros en el pad", () => {
    const bgr = new Uint8Array(4 * 2 * 3).fill(255);
    const lin = normalizarLinea(bgr, 4, 2);
    expect(lin).not.toBeNull();
    // ratio 2 → útil ceil(48*2)=96, total 320.
    expect(lin?.anchoUtil).toBe(96);
    expect(lin?.anchoTotal).toBe(320);
    const t = lin?.tensor as Float32Array;
    expect(t.length).toBe(3 * REC_ALTO * 320);
    expect(t[0]).toBeCloseTo(1, 5);
    expect(t[2 * REC_ALTO * 320]).toBeCloseTo(1, 5); // plano R también
    expect(t[100]).toBeCloseTo(0, 6); // pad derecho
  });

  it("negro → −1", () => {
    const lin = normalizarLinea(new Uint8Array(2 * 2 * 3), 2, 2);
    if (!lin) throw new Error("sin línea");
    expect(lin.tensor[0]).toBeCloseTo(-1, 5);
  });

  it("línea ancha: el total crece sin truncar", () => {
    const lin = normalizarLinea(new Uint8Array(700 * 10 * 3).fill(128), 700, 10);
    expect(lin?.anchoTotal).toBe(Math.floor(48 * 70));
    expect(lin?.anchoUtil).toBeLessThanOrEqual(lin?.anchoTotal as number);
  });

  it("degenerado → null", () => {
    expect(normalizarLinea(new Uint8Array(0), 0, 5)).toBeNull();
    expect(normalizarLinea(new Uint8Array(3), 2, 2)).toBeNull();
  });
});

describe("matrizAfin", () => {
  it("rect eje-alineado → traslación", () => {
    expect(
      matrizAfin(
        [
          [10, 10],
          [110, 10],
          [110, 30],
          [10, 30],
        ],
        100,
        20,
      ),
    ).toEqual([1, 0, 0, 1, 10, 10]);
  });

  it("lleva (W,0)→p1 y (0,H)→p3", () => {
    const poli = [
      [5, 5],
      [25, 9],
      [23, 19],
      [3, 15],
    ] as const;
    const [a, b, c, d, e, f] = matrizAfin([poli[0], poli[1], poli[2], poli[3]], 20, 10);
    expect([a * 20 + e, b * 20 + f]).toEqual([25, 9]);
    expect([c * 10 + e, d * 10 + f]).toEqual([3, 15]);
  });
});

describe("decodificarCtc", () => {
  const dict = ["blank", "a", "b", " ", "c"];

  /** Logits de pasos×clases con argmax y prob dados por fila. */
  function logits(filas: Array<readonly [number, number]>): Float32Array {
    const out = new Float32Array(filas.length * dict.length);
    filas.forEach(([cls, p], t) => {
      out[(t ?? 0) * dict.length + (cls ?? 0)] = p ?? 0;
    });
    return out;
  }

  it("colapsa repetidos y quita blank", () => {
    const r = decodificarCtc(
      logits([
        [1, 0.9],
        [1, 0.8],
        [0, 0.99],
        [2, 0.7],
        [2, 0.6],
        [2, 0.5],
        [4, 0.95],
      ]),
      7,
      dict,
    );
    expect(r.texto).toBe("abc");
    expect(r.puntaje).toBeCloseTo((0.9 + 0.7 + 0.95) / 3, 6);
  });

  it("conserva espacios intermedios", () => {
    const r = decodificarCtc(
      logits([
        [1, 0.9],
        [3, 0.9],
        [2, 0.9],
      ]),
      3,
      dict,
    );
    expect(r.texto).toBe("a b");
  });

  it("todo blank → vacío con puntaje 0", () => {
    expect(decodificarCtc(logits([[0, 1]]), 1, dict)).toEqual({ texto: "", puntaje: 0 });
  });

  it("formas que no cuadran → vacío sin lanzar", () => {
    expect(decodificarCtc(new Float32Array(7), 3, dict)).toEqual({ texto: "", puntaje: 0 });
    expect(decodificarCtc(new Float32Array(0), 0, dict)).toEqual({ texto: "", puntaje: 0 });
  });
});

describe("DICT_OCR", () => {
  it("18710 clases del rec + marcas", () => {
    expect(DICT_OCR.length).toBe(18710);
    expect(DICT_OCR[0]).toBe("blank");
    expect(DICT_OCR[1]).toBe("!");
    expect(DICT_OCR[4]).toBe("$");
    expect(DICT_OCR[DICT_OCR.length - 1]).toBe(" ");
    expect(DICT_OCR).toContain("€");
    expect(DICT_OCR).toContain("ñ");
    expect(DICT_OCR).toContain("TOTAL".slice(0, 1));
  });
});
