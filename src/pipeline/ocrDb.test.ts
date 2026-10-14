/* Tests: ocrDb — post-proceso DB puro (binarizar, contornos, casco,
   rectángulo mínimo, puntaje, unclip) sin onnx ni DOM. */
import { describe, expect, it } from "vite-plus/test";
import {
  binarizarMapa,
  cajasDesdeMapa,
  cascoConvexo,
  expandirQuad,
  interseccionRectas,
  inundar,
  ordenarQuad,
  proyectarCasco,
  puntuarCaja,
  puntoEnQuad,
  rectaDesplazada,
  rectanguloMinimo,
} from "./ocrDb";
import type { CajaDb } from "./ocrDb";

/** Máscara binaria con borde (como la de binarizarMapa) desde set de píxeles. */
function mascara(w: number, h: number, pixeles: Array<readonly [number, number]>): Uint8Array {
  const bin = new Uint8Array((w + 2) * (h + 2));
  for (const [x, y] of pixeles) bin[(y + 1) * (w + 2) + x + 1] = 1;
  return bin;
}

/** Mapa Float32 de wxh con rectángulo brillante (resto 0.05). */
function mapaConRect(
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  v = 0.9,
): Float32Array {
  const mapa = new Float32Array(w * h).fill(0.05);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) mapa[y * w + x] = v;
  }
  return mapa;
}

describe("binarizarMapa", () => {
  it("umbral 0.2 y borde cero", () => {
    // 0.19 bajo el umbral (0.2f en Float32 queda apenas sobre 0.2: se evita el borde).
    const bin = binarizarMapa(new Float32Array([0.1, 0.3, 0.19, 0.9]), 2, 2);
    expect(bin.length).toBe(16);
    // Interior 2x2 en máscara 4x4 con borde.
    expect([bin[5], bin[6], bin[9], bin[10]]).toEqual([0, 1, 0, 1]);
    expect(bin[0]).toBe(0);
  });
});

describe("inundar", () => {
  it("cuadrado 2x2 → sus 4 píxeles en coords de mapa", () => {
    const bin = mascara(4, 4, [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
    const pts = inundar(bin, 6, new Uint32Array(36), 2, 2, 1)
      .map(([x, y]) => `${x},${y}`)
      .sort();
    expect(pts).toEqual(["1,1", "1,2", "2,1", "2,2"]);
  });

  it("contacto diagonal une (8-vecinos)", () => {
    const bin = mascara(3, 3, [
      [0, 0],
      [1, 1],
    ]);
    expect(inundar(bin, 5, new Uint32Array(25), 1, 1, 1)).toHaveLength(2);
  });

  it("borde caliente no se sale del mapa (toleran vistas raras)", () => {
    // Sin borde de 1px a propósito: los vecinos OOB dan undefined.
    const bin = new Uint8Array([1, 0, 0, 0]);
    expect(inundar(bin, 2, new Uint32Array(4), 0, 0, 1)).toEqual([[-1, -1]]);
  });
});

describe("cascoConvexo", () => {
  it("cuadrado con punto interior → 4 vértices", () => {
    const h = cascoConvexo([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1],
    ]);
    expect(h).toHaveLength(4);
  });

  it("duplicados no duplican vértices", () => {
    expect(
      cascoConvexo([
        [0, 0],
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ]),
    ).toHaveLength(4);
  });

  it("menos de 3 únicos se devuelven tal cual", () => {
    expect(
      cascoConvexo([
        [0, 0],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("rectanguloMinimo", () => {
  it("rect eje-alineado → misma área", () => {
    const r = rectanguloMinimo([
      [1, 1],
      [5, 1],
      [5, 3],
      [1, 3],
    ]);
    expect(r).not.toBeNull();
    const xs = (r ?? []).map((p) => p[0]);
    const ys = (r ?? []).map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(4, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2, 6);
  });

  it("degenerado (<3 puntos) → null", () => {
    expect(
      rectanguloMinimo([
        [0, 0],
        [1, 1],
      ]),
    ).toBeNull();
  });

  it("arista de largo cero se salta", () => {
    const r = rectanguloMinimo([
      [0, 0],
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    expect(r).not.toBeNull();
  });
});

describe("proyectarCasco", () => {
  it("proyecta el cuadrado sobre X", () => {
    expect(
      proyectarCasco(
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
        ],
        1,
        0,
      ),
    ).toEqual({ minU: 0, maxU: 2, minV: 0, maxV: 2 });
  });
});

describe("puntoEnQuad", () => {
  // enrollados verificados a mano (shoelace ±32).
  const ccw: CajaDb["poli"] = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  const cw: CajaDb["poli"] = [
    [0, 0],
    [0, 4],
    [4, 4],
    [4, 0],
  ];

  it("dentro/fuera en antihorario", () => {
    expect(puntoEnQuad(ccw, 2, 2, false)).toBe(true);
    expect(puntoEnQuad(ccw, 5, 5, false)).toBe(false);
  });

  it("dentro/fuera en horario", () => {
    expect(puntoEnQuad(cw, 2, 2, true)).toBe(true);
    expect(puntoEnQuad(cw, 5, 5, true)).toBe(false);
  });
});

describe("ordenarQuad", () => {
  it("barajado → sup-izq, sup-der, inf-der, inf-izq", () => {
    const q = ordenarQuad([
      [10, 5],
      [0, 0],
      [0, 5],
      [10, 0],
    ]);
    expect(q).toEqual([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ]);
  });
});

describe("puntuarCaja", () => {
  it("mapa uniforme → su valor", () => {
    const mapa = new Float32Array(16).fill(0.9);
    expect(
      puntuarCaja(mapa, 4, [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
      ]),
    ).toBeCloseTo(0.9, 6);
  });

  it("media real dentro del quad", () => {
    const mapa = new Float32Array([0.1, 0.1, 0.9, 0.9]);
    expect(
      puntuarCaja(mapa, 2, [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    ).toBeCloseTo(0.5, 6);
  });

  it("quad horario puntúa igual (enrollado independiente)", () => {
    const mapa = new Float32Array(16).fill(0.9);
    expect(
      puntuarCaja(mapa, 4, [
        [0, 0],
        [0, 3],
        [3, 3],
        [3, 0],
      ]),
    ).toBeCloseTo(0.9, 6);
  });

  it("quad fuera del mapa → 0 sin lanzar", () => {
    const mapa = new Float32Array(16).fill(0.9);
    expect(
      puntuarCaja(mapa, 4, [
        [100, 100],
        [103, 100],
        [103, 103],
        [100, 103],
      ]),
    ).toBe(0);
  });
});

describe("expandirQuad", () => {
  it("cuadrado 10x10 ratio 1.4 → ±3.5px simétrico", () => {
    const q = expandirQuad(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      1.4,
    );
    expect(q).not.toBeNull();
    const xs = (q ?? []).map((p) => p[0]);
    const ys = (q ?? []).map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-3.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(13.5, 6);
    expect(Math.min(...ys)).toBeCloseTo(-3.5, 6);
    expect(Math.max(...ys)).toBeCloseTo(13.5, 6);
  });

  it("degenerado → null", () => {
    expect(
      expandirQuad([
        [1, 1],
        [1, 1],
        [1, 1],
        [1, 1],
      ]),
    ).toBeNull();
  });

  it("arista de longitud cero → null (mod===0)", () => {
    expect(
      expandirQuad([
        [0, 0],
        [0, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBeNull();
  });

  it("horario expande igual (vale con cualquier enrollado)", () => {
    const q = expandirQuad(
      [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
      ],
      1.4,
    );
    expect(q).not.toBeNull();
    const xs = (q ?? []).map((p) => p[0]);
    const ys = (q ?? []).map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-3.5, 6);
    expect(Math.max(...xs)).toBeCloseTo(13.5, 6);
    expect(Math.min(...ys)).toBeCloseTo(-3.5, 6);
    expect(Math.max(...ys)).toBeCloseTo(13.5, 6);
  });

  it("línea sin área → null", () => {
    expect(
      expandirQuad([
        [0, 0],
        [10, 0],
        [20, 0],
        [30, 0],
      ]),
    ).toBeNull();
  });

  it("pico colineal (aristas adyacentes paralelas) → null", () => {
    expect(
      expandirQuad([
        [0, 0],
        [10, 0],
        [5, 0],
        [0, 10],
      ]),
    ).toBeNull();
  });
});

describe("rectaDesplazada/interseccionRectas", () => {
  it("arista nula → null", () => {
    expect(rectaDesplazada([1, 1], [1, 1], 0, 0, 1)).toBeNull();
  });

  it("normal hacia dentro se invierte", () => {
    // Arista izq (0,0)->(0,10) con centroide a la derecha: la normal mira dentro.
    expect(rectaDesplazada([0, 0], [0, 10], 5, 5, 0)).toEqual({ nx: -1, ny: 0, c: 0 });
  });

  it("paralelas no se cortan", () => {
    expect(interseccionRectas({ nx: 0, ny: -1, c: 5 }, { nx: 0, ny: -1, c: 3 })).toBeNull();
  });

  it("perpendiculares se cortan en el origen", () => {
    expect(interseccionRectas({ nx: 1, ny: 0, c: 0 }, { nx: 0, ny: 1, c: 0 })).toEqual([0, 0]);
  });
});

describe("cajasDesdeMapa", () => {
  it("rect brillante → 1 caja con bbox y puntaje", () => {
    const cajas = cajasDesdeMapa(mapaConRect(20, 10, 5, 2, 14, 7), 20, 10, {
      ancho: 40,
      alto: 20,
    });
    expect(cajas).toHaveLength(1);
    const c = cajas[0] as CajaDb;
    expect(c.puntaje).toBeGreaterThan(0.8);
    const xs = c.poli.map((p) => p[0]);
    const ys = c.poli.map((p) => p[1]);
    // bbox mapa x[2.75,16.25] y[0,9.25] a escala 2 (d=2.25 en mapa).
    expect(Math.min(...xs)).toBeCloseTo(5.5, 0);
    expect(Math.max(...xs)).toBeCloseTo(32.5, 0);
    expect(Math.min(...ys)).toBeCloseTo(0, 0);
    expect(Math.max(...ys)).toBeCloseTo(18.5, 0);
  });

  it("mapa vacío → sin cajas", () => {
    expect(
      cajasDesdeMapa(new Float32Array(200).fill(0.01), 20, 10, { ancho: 40, alto: 20 }),
    ).toEqual([]);
  });

  it("rect tenue bajo el umbral de caja → sin cajas", () => {
    expect(
      cajasDesdeMapa(mapaConRect(20, 10, 5, 2, 14, 7, 0.3), 20, 10, {
        ancho: 40,
        alto: 20,
      }),
    ).toEqual([]);
  });

  it("barra ancha 100x10 → bbox completo (regresión: el trazado la partía)", () => {
    const mapa = new Float32Array(120 * 30).fill(0.05);
    for (let y = 5; y <= 14; y += 1) {
      for (let x = 10; x <= 109; x += 1) mapa[y * 120 + x] = 0.9;
    }
    const cajas = cajasDesdeMapa(mapa, 120, 30, { ancho: 120, alto: 30 });
    expect(cajas).toHaveLength(1);
    const xs = (cajas[0] as CajaDb).poli.map((p) => p[0]);
    const ys = (cajas[0] as CajaDb).poli.map((p) => p[1]);
    // d = 99*9*1.4/216 ≈ 5.8 → x[4.2,114.8], y clamped [0,19.8].
    expect(Math.min(...xs)).toBeCloseTo(4.2, 0);
    expect(Math.max(...xs)).toBeCloseTo(114.8, 0);
    expect(Math.min(...ys)).toBeCloseTo(0, 0);
    expect(Math.max(...ys)).toBeCloseTo(19.8, 0);
  });

  it("diamante rotado 45° no se descarta (área real 8, no 0)", () => {
    const mapa = new Float32Array(9 * 9).fill(0.05);
    const pixeles: Array<readonly [number, number]> = [
      [4, 2],
      [3, 3],
      [4, 3],
      [5, 3],
      [2, 4],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
      [3, 5],
      [4, 5],
      [5, 5],
      [4, 6],
    ];
    for (const [x, y] of pixeles) mapa[y * 9 + x] = 1;
    expect(cajasDesdeMapa(mapa, 9, 9, { ancho: 9, alto: 9 })).toHaveLength(1);
  });

  it("borde irregular en escalera → bbox completo", () => {
    const mapa = new Float32Array(120 * 30).fill(0.05);
    for (let y = 5; y <= 14; y += 1) {
      for (let x = 10 + (y % 3) * 4; x <= 109; x += 1) mapa[y * 120 + x] = 0.9;
    }
    const cajas = cajasDesdeMapa(mapa, 120, 30, { ancho: 120, alto: 30 });
    expect(cajas).toHaveLength(1);
    const xs = (cajas[0] as CajaDb).poli.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(20);
    expect(Math.max(...xs)).toBeGreaterThan(100);
  });

  it("entradas inválidas → sin cajas sin lanzar", () => {
    expect(cajasDesdeMapa(new Float32Array(4), 10, 10, { ancho: 40, alto: 20 })).toEqual([]);
    expect(cajasDesdeMapa(new Float32Array(100), 0, 10, { ancho: 40, alto: 20 })).toEqual([]);
    expect(cajasDesdeMapa(new Float32Array(100), 10, 0, { ancho: 40, alto: 20 })).toEqual([]);
    expect(cajasDesdeMapa(new Float32Array(100), 10, 10, { ancho: 0, alto: 20 })).toEqual([]);
    expect(cajasDesdeMapa(new Float32Array(100), 10, 10, { ancho: 40, alto: 0 })).toEqual([]);
  });

  it("píxel suelto sin área se descarta", () => {
    const mapa = new Float32Array(100).fill(0.05);
    mapa[55] = 0.9;
    expect(cajasDesdeMapa(mapa, 10, 10, { ancho: 10, alto: 10 })).toEqual([]);
  });

  it("dúo sin rectángulo se descarta", () => {
    const mapa = new Float32Array(100).fill(0.05);
    mapa[55] = 0.9;
    mapa[56] = 0.9;
    expect(cajasDesdeMapa(mapa, 10, 10, { ancho: 10, alto: 10 })).toEqual([]);
  });

  it("triplete colineal sin expansión se descarta", () => {
    const mapa = new Float32Array(100).fill(0.05);
    mapa[55] = 0.9;
    mapa[56] = 0.9;
    mapa[57] = 0.9;
    expect(cajasDesdeMapa(mapa, 10, 10, { ancho: 10, alto: 10 })).toEqual([]);
  });

  it("caja reescalada bajo el área mínima se descarta", () => {
    const mapa = mapaConRect(10, 10, 3, 3, 6, 6);
    expect(cajasDesdeMapa(mapa, 10, 10, { ancho: 10, alto: 10 })).toHaveLength(1);
    expect(cajasDesdeMapa(mapa, 10, 10, { ancho: 2, alto: 2 })).toEqual([]);
  });
});
