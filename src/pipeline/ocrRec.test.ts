/* Tests: ocrRec — normalización de línea, matriz afín y CTC greedy
   (puros; el lienzo solo lo toca ocr.ts). */
import { describe, expect, it } from "vite-plus/test";
import {
  decodificarCtc,
  matrizAfin,
  normalizarLinea,
  normalizarLote,
  REC_ALTO,
  REC_RATIO_MAXIMA,
} from "./ocrRec";
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

  it("línea ancha: el total crece sin truncar (bajo el tope)", () => {
    const lin = normalizarLinea(new Uint8Array(640 * 30 * 3).fill(128), 640, 30);
    expect(lin?.anchoTotal).toBe(Math.floor(48 * (640 / 30)));
    expect(lin?.anchoUtil).toBeLessThanOrEqual(lin?.anchoTotal as number);
  });

  it("degenerado → null", () => {
    expect(normalizarLinea(new Uint8Array(0), 0, 5)).toBeNull();
    expect(normalizarLinea(new Uint8Array(3), 2, 2)).toBeNull();
  });

  it("borde izquierdo replica (sin extrapolar fuera de [-1,1])", () => {
    // 2×1: px0 oscuro, px1 claro. La 1ª columna muestrea x<0 → réplica px0.
    const lin = normalizarLinea(new Uint8Array([10, 20, 30, 200, 210, 220]), 2, 1);
    if (!lin) throw new Error("sin línea");
    expect(lin.tensor[0]).toBeCloseTo((10 / 255 - 0.5) / 0.5, 5);
  });

  it("hebra 480:1 se topa a ratio 32", () => {
    const lin = normalizarLinea(new Uint8Array(4800 * 10 * 3).fill(128), 4800, 10);
    expect(lin?.anchoTotal).toBe(REC_ALTO * REC_RATIO_MAXIMA);
  });
});

describe("normalizarLote", () => {
  const bgrA = new Uint8Array(100 * 20 * 3).fill(128);
  const bgrB = new Uint8Array(640 * 30 * 3).fill(64);

  it("apila con pad de ceros: la ancha intacta, la corta con ceros (L2)", () => {
    const a = normalizarLinea(bgrA, 100, 20);
    const b = normalizarLinea(bgrB, 640, 30);
    if (!a || !b) throw new Error("sin líneas");
    const lote = normalizarLote([
      { bgr: bgrA, w: 100, h: 20 },
      { bgr: bgrB, w: 640, h: 30 },
    ]);
    if (!lote) throw new Error("sin lote");
    expect(lote.lote).toBe(2);
    const wMax = Math.max(a.anchoTotal, b.anchoTotal);
    expect(lote.anchoMax).toBe(wMax);
    expect(lote.tensor.length).toBe(2 * 3 * REC_ALTO * wMax);
    const plano = REC_ALTO * wMax;
    // La ancha (sin pad si es la mayor): bloque idéntico al individual.
    const ancha = b.anchoTotal >= a.anchoTotal ? { n: b, base: 3 } : { n: a, base: 0 };
    const planoAncha = REC_ALTO * ancha.n.anchoTotal;
    for (let c = 0; c < 3; c += 1) {
      for (let y = 0; y < REC_ALTO; y += 1) {
        expect(
          lote.tensor.slice(
            (ancha.base + c) * plano + y * wMax,
            (ancha.base + c) * plano + (y + 1) * wMax,
          ),
        ).toEqual(
          ancha.n.tensor.slice(
            c * planoAncha + y * ancha.n.anchoTotal,
            c * planoAncha + (y + 1) * ancha.n.anchoTotal,
          ),
        );
      }
    }
    // La corta: ceros a la derecha de su ancho total.
    const corta = b.anchoTotal >= a.anchoTotal ? { n: a, base: 0 } : { n: b, base: 3 };
    for (let c = 0; c < 3; c += 1) {
      for (let y = 0; y < REC_ALTO; y += 1) {
        const pad = lote.tensor.slice(
          (corta.base + c) * plano + y * wMax + corta.n.anchoTotal,
          (corta.base + c) * plano + (y + 1) * wMax,
        );
        expect(pad.every((v) => v === 0)).toBe(true);
      }
    }
  });

  it("vacío o degenerado → null", () => {
    expect(normalizarLote([])).toBeNull();
    expect(normalizarLote([{ bgr: new Uint8Array(0), w: 0, h: 5 }])).toBeNull();
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
    expect(DICT_OCR).toContain("T");
  });
});
