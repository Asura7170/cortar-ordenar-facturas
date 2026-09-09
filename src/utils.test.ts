/* Tests: sanear nunca deja "[object Object]" llegar al DOM. */
import { describe, expect, it } from "vite-plus/test";
import { sanear } from "./utils";

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
