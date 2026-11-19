/* Tests P0: forma de wasmPaths (la sincronía con package.json la amarra el grep de ort-bump). */
import { describe, expect, it } from "vite-plus/test";

import { VERSION_ORT, rutaWasmOrt } from "./ortWasm";

describe("rutaWasmOrt", () => {
  it("PROD al CDN pineado con trailing /, dev al local", () => {
    expect(VERSION_ORT).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(rutaWasmOrt(true, "/")).toBe(
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VERSION_ORT}/dist/`,
    );
    expect(rutaWasmOrt(false, "/app/")).toBe("/app/ort/");
  });
});
