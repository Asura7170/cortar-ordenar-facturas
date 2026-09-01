# Advanced JavaScript Cheat Sheet: 2024 - 2026 Updates

**Scope Summary:** Comprehensive reference of all new, standardized, and stabilized JavaScript (ECMAScript) and Web Platform (Browser API) features released between 2024 and 2026. Covers core language features, built-ins, DOM/Web APIs, Chrome-specific implementations, experimental features, and deprecations. All information verified against MDN, TC39 proposals, Chrome release notes, and web.dev Baseline as of 2026.

---

## 1. Core Language Features (ECMAScript)

### Syntax

#### `using` / `await using` — Explicit Resource Management
- **Status:** Standardized (ES2026), Chrome 139+ (experimental → stable progressive)
- **Syntax/Usage:**
```javascript
function openFile(path) {
  const handle = fs.openSync(path, "r");
  return { handle, [Symbol.dispose]() { fs.closeSync(handle); } };
}
function readConfig() {
  using file = openFile("./config.json");
  // ...read
} // file closed automatically, even on throw
```
- **Description:** Declarative resource cleanup. Calls `[Symbol.dispose]()` on scope exit in reverse declaration order; `await using` calls `[Symbol.asyncDispose]()`. Eliminates `finally` blocks for files, DB transactions, locks.
- **Browser Support:** Chrome 139+ (progressively), Firefox 139+, Safari 18.4+ (partial), Node.js 24+.

#### `import defer` — Deferred Module Evaluation
- **Status:** Stage 3 (TC39)
- **Syntax/Usage:**
```javascript
import defer * as heavy from "./heavy-feature.js";
// module not executed yet
if (userClicked) { heavy.run(); } // evaluates on first access
```
- **Description:** Loads a module but defers its top-level evaluation until an export is actually used. Saves startup cost for conditional/heavy modules. Works with namespace imports only.
- **Browser Support:** Experimental; not yet in stable Chrome.

#### Import Attributes (`with` syntax)
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
import config from "./config.json" with { type: "json" };
const data = await import("./data.json", { with: { type: "json" } });
```
- **Description:** Attach metadata to imports; primary use is JSON modules without a bundler. Replaces the old `assert` syntax.
- **Browser Support:** Chrome 123+, Firefox 138+, Safari 18.2+.

#### Source Phase Imports / ESM Phase Imports
- **Status:** Stage 3 (TC39)
- **Syntax/Usage:** `import source x from "..."` (loading source text without parsing)
- **Description:** Import raw source text or module bytes directly, enabling compile-in-browser and code analysis workflows.
- **Browser Support:** Proposal; not yet shipped.

#### Decorators / Decorator Metadata
- **Status:** Stage 2.7 (TC39)
- **Syntax/Usage:**
```javascript
@decorator
class Example {
  @log accessor value;
}
```
- **Description:** Declarative class/member enhancement: logging, memoization, DI, reactivity. Decorator Metadata adds introspection.
- **Browser Support:** Proposal; TypeScript 5.x provides native compilation.

### Methods (Array, Object, String, Promise, RegExp, Map, Set, Iterator)

#### `Object.groupBy` / `Map.groupBy` — ES2024
- **Status:** Standardized (ES2024), Baseline
- **Syntax/Usage:**
```javascript
Object.groupBy(iterable, fn); // returns object (null prototype)
Map.groupBy(iterable, fn);   // returns Map
```
- **Description:** Group iterable items by key from callback. `Object.groupBy` returns null-prototype object (use `Object.hasOwn`); `Map.groupBy` supports non-string keys.
- **Browser Support:** Chrome 117+, Firefox 119+, Safari 17.4+.

#### `Promise.withResolvers` — ES2024
- **Status:** Standardized (ES2024), Baseline
- **Syntax/Usage:**
```javascript
const { promise, resolve, reject } = Promise.withResolvers();
```
- **Description:** Creates a promise with external `resolve`/`reject`. Replaces manual constructor-expose pattern.
- **Browser Support:** Chrome 119+, Firefox 121+, Safari 17.4+.

#### `String.prototype.isWellFormed` / `toWellFormed` — ES2024
- **Status:** Standardized (ES2024)
- **Syntax/Usage:**
```javascript
str.isWellFormed(); // true/false (lone surrogates?)
str.toWellFormed(); // replace lone surrogates with U+FFFD
```
- **Description:** Validate/repair UTF-16 strings. `toWellFormed()` prevents `encodeURIComponent` URIError on malformed input.
- **Browser Support:** Chrome 111+, Firefox 119+, Safari 17.4+.

#### RegExp `/v` flag (Unicode Sets) — ES2024
- **Status:** Standardized (ES2024)
- **Syntax/Usage:**
```javascript
const re = /[\p{Script=Greek}--[αεηιοωυ]]/v;
```
- **Description:** Unicode-aware regex with set notation (`--` difference, `&&` intersection, `||` union) and string literals in classes. Upgrade from `/u`.
- **Browser Support:** Chrome 112+, Firefox 116+, Safari 17+.

#### `Array.fromAsync` — Stage 3
- **Status:** Stage 3 (TC39) / Chrome 126+ (behind flag)
- **Syntax/Usage:**
```javascript
const arr = await Array.fromAsync(asyncIterable);
```
- **Description:** Async version of `from()` — creates array from async iterables or promise-returning items. Alternative to manual `for await` mapping.
- **Browser Support:** Chrome 126+ (flag), Safari 17.4+ (partial).

### Iterator Helpers — ES2025
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
const result = naturals()
  .filter((n) => n % 2 === 0)
  .map((n) => n ** 2)
  .take(5)
  .toArray();
```
- **Description:** Lazy, chainable methods on the iterator protocol: `.map()`, `.filter()`, `.take(n)`, `.drop(n)`, `.flatMap()`, `.reduce()`, `.toArray()`, `.forEach()`, `.some()`, `.every()`, `.find()`, `.findLast()`, `.includes()`, `.join()`, `.chunks()`, `.windows()`. Works on Map, Set, generators.
- **Browser Support:** Chrome 122+, Firefox 128+, Safari 19+.

### Set Methods — ES2025
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
a.intersection(b);        // common elements
a.union(b);               // all elements
a.difference(b);          // in a not b
a.symmetricDifference(b); // in a or b but not both
a.isSubsetOf(b);
a.isSupersetOf(b);
a.isDisjointFrom(b);
```
- **Description:** Seven set-theoretic methods on `Set.prototype`; all accept any iterable.
- **Browser Support:** Chrome 122+, Firefox 127+, Safari 17+.

### `Promise.try` — ES2025
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
const result = await Promise.try(() => getUser(id));
```
- **Description:** Wraps a function, catching both sync throws and async rejections uniformly. Replaces `Promise.resolve().then()` guards.
- **Browser Support:** Chrome 120+, Firefox 129+, Safari 18+.

### `RegExp.escape` — ES2025
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
const safe = new RegExp(RegExp.escape(userInput));
```
- **Description:** Escapes literal regex metacharacters in user input, preventing regex injection.
- **Browser Support:** Chrome 112+, Firefox 122+, Safari 17.4+.

### `Float16Array` — ES2025
- **Status:** Standardized (ES2025), Baseline 2025
- **Syntax/Usage:**
```javascript
const f16 = new Float16Array([1.5, 2.25]);
new DataView(buffer).getFloat16(0);
```
- **Description:** 16-bit half-precision float typed array + `DataView.getFloat16/setFloat16`. For media, GPU, ML precision trade-offs.
- **Browser Support:** Chrome 126+, Firefox 128+, Safari 18.2+.

### `Error.isError` — ES2026
- **Status:** Standardized (ES2026)
- **Syntax/Usage:**
```javascript
Error.isError(new Error("oops")); // true
Error.isError({ message: "fake" }); // false
```
- **Description:** Reliable cross-realm error check via internal structure. Use instead of `instanceof Error` (fails across iframes/workers).
- **Browser Support:** Chrome 130+, Firefox 138+, Safari 18+.

### `Math.sumPrecise` — ES2026
- **Status:** Standardized (ES2026), Chrome 147+
- **Syntax/Usage:**
```javascript
Math.sumPrecise([0.1, 0.2, 0.3]); // 0.6 (not 0.6000000000000001)
```
- **Description:** Precise summation of an iterable of numbers without accumulated floating-point drift.
- **Browser Support:** Chrome 147+, Firefox 130+, Safari 26.4+.

### `Uint8Array` base64 / hex — ES2026
- **Status:** Standardized (ES2026), Chrome 140+, Baseline 2025
- **Syntax/Usage:**
```javascript
bytes.toBase64();  // "SGVsbG8="
bytes.toHex();     // "48656c6c6f"
Uint8Array.fromBase64("SGVsbG8=");
Uint8Array.fromHex("48656c6c6f");
```
- **Description:** Direct byte↔base64/hex conversion on `Uint8Array`. Replaces the `atob`/`btoa` + `String.fromCharCode` dance.
- **Browser Support:** Chrome 140+, Firefox 133+, Safari 18.2+.

### `Map.getOrInsert` / `getOrInsertComputed` (Upsert) — ES2026
- **Status:** Standardized (ES2026), Chrome 145+
- **Syntax/Usage:**
```javascript
const group = map.getOrInsert(key, []);
const cached = cache.getOrInsertComputed(id, () => expensiveLoad(id));
```
- **Description:** Get key or set default in one call. `getOrInsertComputed` uses lazy callback (only on miss). Also on `WeakMap`.
- **Browser Support:** Chrome 145+, Firefox 138+, Safari 26.4+.

### `Iterator.concat` / Iterator `includes` / Iterator `chunking` / `windows` — Stage 3
- **Status:** Stage 3 (TC39), progressively shipping
- **Syntax/Usage:**
```javascript
const it = Iterator.concat(it1, it2);
it.includes(value);
it.chunks(3);
it.windows(2);
```
- **Description:** Extend lazy iterator toolkit: concatenate iterators, membership checks, chunking/sliding windows. `Iterator.concat` shipped partially in Chrome 145+.
- **Browser Support:** Progressive; `windows`/`chunks` in MDN reference, not fully cross-browser yet.

### `Object.entries`/`Object.values`-style performance & `JSON.parse` source text
- **Status:** Standardized (ES2026 via JSON module work) — `JSON.parse` source text access
- **Syntax/Usage:** `JSON.isRawJSON()` (source text interop)
- **Description:** Access raw JSON source text in `JSON.parse` for identity-preserving transformations. Used with `JSON.parse` returning `RawJSON` values.
- **Browser Support:** Chrome 130+ (partial), Firefox 137+.

---

## 3. Web Platform & Browser APIs

### DOM / Document

#### View Transitions API (SPA + MPA)
- **Method/Event:** `document.startViewTransition(callback)`, `@view-transition`, `ViewTransition.finished`, `waitUntil()`, `document.activeViewTransition`
- **Usage Example:**
```javascript
const vt = document.startViewTransition(() => updateDOM());
await vt.finished;
```
- **Description:** Animate DOM changes (and cross-page navigations). `@view-transition { navigation: auto }` enables MPA transitions; `waitUntil()` keeps transition alive for async work.
- **Note:** Baseline 2025 (SPA); MPA Chrome 134+, Firefox 133+, Safari 18.2+.

#### Navigation API
- **Method/Event:** `navigation.navigate()`, `NavigateEvent`, `precommit` handlers, `navigation.transition.destination`
- **Usage Example:**
```javascript
navigation.addEventListener("navigate", (e) => {
  e.intercept({ handler: async () => { /* render */ } });
});
```
- **Description:** Declarative same-document navigation interception, precommit, and transition control. Replaces `history.pushState` hacks for SPAs.
- **Note:** Baseline 2026; Chrome 102+, Firefox 136+, Safari 18.4+.

#### `document.caretPositionFromPoint()` / `document.parseHTMLUnsafe()`
- **Status:** Baseline 2025
- **Usage Example:**
```javascript
const pos = document.caretPositionFromPoint(x, y);
const doc = document.parseHTMLUnsafe(htmlString);
```
- **Description:** Caret position from coordinates; unsanitized HTML parsing (like `DOMParser` but static, equivalent to `innerHTML`). Useful for rich-text editors.
- **Note:** `parseHTMLUnsafe` replaces manual `DOMParser` workarounds.

#### `document.scripts()` — New static method (2026)
- **Status:** Chrome 145+
- **Usage Example:**
```javascript
const scripts = document.scripts();
```
- **Description:** Returns all scripts in the document; a modern equivalent of `document.getElementsByTagName('script')`.
- **Note:** Part of DOM spec updates.

#### `Element.closest()` with pseudo / `ScrollTimeline`
- **Status:** Chrome 145+
- **Description:** Query closest ancestor matching selector including pseudo-elements for scroll timeline anchors.

### Fetch / Streams / Network

#### `Response`, `Request`, `Blob` — `textStream()` / `bytesStream()` (2026)
- **Status:** Chrome 151+
- **Usage Example:**
```javascript
const stream = await response.textStream();
for await (const chunk of stream) { /* process */ }
```
- **Description:** Streaming text/bytes directly from responses without manual TextDecoder.
- **Note:** Replaces the `response.body.getReader()` boilerplate for text streams.

#### `fetch()` streaming requests & uploads
- **Status:** Stable (Chrome 105+, improved through 2026)
- **Usage Example:**
```javascript
await fetch("/upload", { method: "POST", body: stream });
```
- **Description:** Stream request bodies (ReadableStream) for uploads without buffering to memory.
- **Note:** Improves large file/multipart uploads.

#### WebTransport
- **Status:** Baseline 2026; Chrome 97+, improved 2025
- **Description:** Low-latency, multiplexed transport over QUIC with streams and datagrams. For real-time apps (game state, trading).
- **Note:** Alternative to WebSocket for high-performance needs.

#### Readable byte streams
- **Status:** Baseline 2026
- **Description:** `ReadableByteStreamController` for BYOB (bring-your-own-buffer) streams — zero-copy reading.
- **Note:** Critical for high-throughput data processing.

#### `compression` / stream compression (DecompressionStream)
- **Status:** Stable 2024+
- **Description:** Gzip/deflate streams natively (`CompressionStream`, `DecompressionStream`).
- **Note:** Replaces manual compression libs for payloads.

### Crypto & Binary

#### WebCrypto — X25519 / Ed25519 (Secure Curves)
- **Status:** Chrome 137+ (Ed25519), X25519 Chrome 142+; Firefox 130+, Safari 18.4+
- **Usage Example:**
```javascript
const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"]);
const sig = await crypto.subtle.sign("Ed25519", key, data);
```
- **Description:** Modern curve cryptography (Ed25519 signatures, X25519 ECDH) in the Web Crypto API.
- **Note:** Adds to existing ECDSA/ECDH; recommended for modern TLS-style operations.

#### WebCrypto algorithm updates (2026)
- **Status:** Chrome 151+
- **Description:** Updated algorithm implementations, alignment with spec for PBKDF2/AES-GCM edge cases.

#### `Uint8Array` base64/hex
- **Status:** Chrome 140+, Baseline 2025 (see ES2026 section)
- **Description:** Binary↔text conversion on the typed array itself.

#### Immutable ArrayBuffers
- **Status:** Stage 2.7/3 (TC39), Chrome behind flag
- **Description:** Create `ArrayBuffer`/`SharedArrayBuffer` that cannot be resized or modified, for security and sharing across workers.
- **Note:** Experimental; related to `structuredClone` safety.

#### `structuredClone()` improvements
- **Status:** Stable across browsers (2024+), improved for WebAssembly/transferables
- **Description:** Deep-clone objects with transferable support natively.

### Worker / Threading

#### `Atomics.waitAsync()` / `Atomics.pause()`
- **Status:** Baseline 2025 (waitAsync), pause Chrome 143+
- **Usage Example:**
```javascript
const { value } = await Atomics.waitAsync(int32, 0, 0);
```
- **Description:** Asynchronous atomics wait (doesn't block main thread); `pause()` hints the CPU for spin-wait loops.
- **Note:** `Atomics.wait` remains sync/blocking; `waitAsync` enables async patterns.

#### SharedWorker JavaScript modules / SharedWorker on Android
- **Status:** Baseline 2026; Chrome 148+ (Android)
- **Description:** Shared workers now support ES modules and are available on Android.
- **Note:** Previously limited to non-module scripts.

#### Service Worker JavaScript modules
- **Status:** Baseline 2026
- **Description:** Service workers can use `{ type: "module" }` registrations.

### Performance & Observability

#### `PerformanceSoftNavigation` / `InteractionContentfulPaint` entries
- **Status:** Chrome 151+
- **Description:** New performance entries for soft navigations and interaction-driven contentful paint, improving INP/LCP measurement.

#### `PerformanceObserver` declarative (2026)
- **Status:** Chrome 151+
- **Description:** Declarative performance observation setup without imperative observer management.

#### Reporting API / CSP violation reports
- **Status:** Baseline 2026
- **Description:** `ReportingObserver` for browser-generated reports (CSP violations, deprecations).

#### Event Timing (`EventCounts`) & LCP
- **Status:** Baseline 2025
- **Description:** `EventCounts` for interaction timing; LCP as a performance entry.

#### `interactionCount` (Performance and Event Timing)
- **Status:** Chrome 144+
- **Description:** Count of user interactions for INP-style metrics.

#### Container Timing API
- **Status:** Chrome 148+
- **Description:** Report layout/rendering time for container-based UI updates.

#### Long Animation Frames (LoAF)
- **Status:** Chrome 123+ (Baseline 2025)
- **Description:** Measure long animation frames for jank detection (INP diagnostics).

### Media / UI

#### `clipboardchange` event
- **Status:** Chrome 144+ (with sticky activation 145+)
- **Usage Example:**
```javascript
addEventListener("clipboardchange", () => { /* sync UI */ });
```
- **Description:** Fires when clipboard content changes programmatically — sync UI without polling.
- **Note:** Replaces clipboard polling patterns.

#### `ClipboardItem.supports()` / Selective Clipboard Format Read
- **Status:** Baseline 2025; Chrome 149+ (selective read)
- **Description:** Check supported clipboard formats; selective read avoids reading whole clipboard.

#### `ToggleEvent.source`
- **Status:** Baseline 2026; Chrome 133+
- **Description:** Event property identifying which element triggered a toggle (popover/details).

#### `dialog.requestClose()` / `closedby`
- **Status:** Baseline 2025; Chrome 134+
- **Description:** Programmatically request close with reason; `closedby` controls light-dismiss on dialogs.

#### `document.activeViewTransition`
- **Status:** Chrome 142+
- **Description:** Access the active `ViewTransition` (or null) without storing it manually.

#### `scrollend` event
- **Status:** Baseline 2025
- **Usage Example:**
```javascript
scroller.addEventListener("scrollend", () => { /* do work */ });
```
- **Description:** Fires when scrolling fully ends (after all momentum). Replaces `setTimeout` debounce hacks.

#### Programmatic scroll promises
- **Status:** Chrome 150+
- **Description:** `scrollTo`/`scrollBy` return Promises that resolve on scroll completion.

#### Gamepad event-driven input API
- **Status:** Chrome 149+
- **Description:** Listen for gamepad events instead of polling `navigator.getGamepads()`.

#### Wheel event momentum & Pointer events updates
- **Status:** Chrome 151+ (wheel momentum), pointerrawupdate interop Chrome 142+
- **Description:** Improved input event semantics across browsers.

#### `focusVisible` option on `focus()`
- **Status:** Chrome 145+
- **Description:** `element.focus({ focusVisible: true })` forces focus-visible styling.

### AI / Machine Learning (Chrome-specific)

#### WebNN
- **Status:** Chrome 148+ (in development)
- **Description:** Neural network inference API for on-device ML (like WebGPU for ML models).

#### Prompt API / Summarizer / Translator / LanguageDetector (GenAI)
- **Status:** Chrome 138+ (origin trials, evolving)
- **Description:**
  - `Prompt API` — interface with on-device language models.
  - `Summarizer API` — automatically summarize input text.
  - `Translator API` — translate text/languages.
  - `LanguageDetector API` — detect text language with confidence.
- **Note:** Experimental; behind origin trials / flags with enterprise policy controls.

#### Digital Credentials API
- **Status:** Chrome 141+ (presentation), 143+ (issuance)
- **Description:** Retrieve/issue identity credentials from mobile wallets (passkeys, eID, mdoc-based).

### UX / UI APIs

#### Screen Wake Lock API
- **Status:** Baseline 2025
- **Usage Example:**
```javascript
const lock = await navigator.wakeLock.request("screen");
```
- **Description:** Prevent device screen from sleeping (video players, reading apps).

#### URLPattern
- **Status:** Baseline 2025
- **Description:** URL matching with patterns (routes), replaces manual regex URL parsing.

#### Unsanitized HTML parsing
- **Status:** Baseline 2025
- **Description:** `document.parseHTMLUnsafe()` for fast HTML string → Document conversion.

#### Web App Manifest / Web Install API
- **Status:** Chrome 142-143+
- **Description:** New install flow (`beforeinstallprompt` improvements), Web App Install API for PWAs.

### IndexedDB & Storage

#### IndexedDB `getAllRecords()`, direction option
- **Status:** Chrome 141+
- **Description:** Fetch all records (`getAllRecords()`) and specify cursor direction in `getAll()`/`getAllKeys()`.

#### Cookie Store API `maxAge` attribute
- **Status:** Chrome 145+
- **Description:** Set cookie expiry via `maxAge` in Cookie Store API.

#### Storage Access API (strict same-origin policy)
- **Status:** Chrome 141+
- **Description:** Stricter origin policy for cross-site storage access (third-party cookie phase-out).

#### No-Vary-Search HTTP disk cache
- **Status:** Chrome 141+
- **Description:** Cache responses ignoring varying request headers.

---

## 4. Experimental & Chrome-Specific Features

> Features available in Chrome (stable or behind flags) but not yet fully cross-browser. Use feature detection / `@supports` for safe degradation.

### `Array.fromAsync`
- **Chrome Version Range:** Chrome 126+ (behind flag)
- **Flag Status:** Behind flag / progressive
- **Code Snippet:**
```javascript
const arr = await Array.fromAsync(asyncIterable);
```
- **Caveats:** Requires flag or polyfill; not Baseline yet.

### `Iterator.concat` / `Iterator.includes` / `Iterator.chunks` / `Iterator.windows`
- **Chrome Version Range:** Chrome 145+ (partial, concat)
- **Flag Status:** Behind flag / partial
- **Code Snippet:**
```javascript
const joined = Iterator.concat(gen1(), gen2());
const found = iterator.includes(42);
```
- **Caveats:** Some methods shipped, others Stage 3 — check per-method support.

### `using` / `await using`
- **Chrome Version Range:** Chrome 139+
- **Flag Status:** Behind experimental flag → progressive
- **Code Snippet:**
```javascript
using file = openFile("config.json");
```
- **Caveats:** Requires `--harmony-explicit-resource-management` in some versions; check Target.

### `Temporal` API
- **Chrome Version Range:** Chrome 144+ (behind flag), spec ES2026
- **Flag Status:** Behind flag / shipping progressively
- **Code Snippet:**
```javascript
const now = Temporal.Now.zonedDateTimeISO("Asia/Tokyo");
const later = now.add({ months: 1, days: 3 });
```
- **Caveats:** Not in all engines yet; use `Temporal.Polyfill` for support. Check `Temporal` existence before use.

### `Immutable ArrayBuffer`
- **Chrome Version Range:** Chrome 139+ (behind flag)
- **Flag Status:** Behind flag
- **Code Snippet:**
```javascript
const buf = new ArrayBuffer(16, { maxByteLength: 16 });
Object.defineProperty(buf, "immutable", { value: true });
```
- **Caveats:** Not shipped without flag; proposal Stage 3.

### `ShadowRealm`
- **Chrome Version Range:** No stable ship yet (Stage 3)
- **Flag Status:** Proposal
- **Usage:** Isolated global contexts for plugin/sandbox code without `eval`.
- **Caveats:** Experimental; API may change.

### WebAssembly — Custom descriptors / Branch hinting / `Memory64`
- **Chrome Version Range:** Custom descriptors Chrome 141+; branch hinting 148+; Memory64 Chrome 145+
- **Flag Status:** Progressive
- **Description:** WASM modules with custom descriptors (prototype-based Java-like objects), branch hinting for performance, 64-bit memory.
- **Caveats:** Under active standardization; validate support per feature.

### `document.scripts()`
- **Chrome Version Range:** Chrome 145+
- **Flag Status:** On by default (progressive)
- **Code Snippet:**
```javascript
const allScripts = document.scripts();
```
- **Caveats:** Early implementation; verify `script` collection includes inline scripts.

### `textStream()` / `bytesStream()` on Response/Request/Blob
- **Chrome Version Range:** Chrome 151+
- **Flag Status:** On by default
- **Code Snippet:**
```javascript
for await (const chunk of await response.textStream()) { ... }
```
- **Caveats:** New API; not yet in Firefox/Safari — use `response.body` fallback.

### `screen` / `window` positioning improvements
- **Chrome Version Range:** Chrome 144+ (window position on Android/many screens)
- **Description:** `window.screenX/screenY`, `window.moveTo/screen.moveTo` for multi-window apps.
- **Caveats:** Multi-display support is platform-specific.

### `document.activeViewTransition` / `ViewTransition.waitUntil()`
- **Chrome Version Range:** Chrome 142+ (activeViewTransition), 144+ (waitUntil)
- **Flag Status:** On by default (progressive)
- **Code Snippet:**
```javascript
const vt = document.startViewTransition(() => update());
await vt.updateCallbackDone;
```
- **Caveats:** Cross-browser coverage differs; MPA transitions need `@view-transition`.

---

## 5. Deprecated & Removed Features

### Removed in Chrome 144
- **SharedStorage API** — removed (replaced by privacy-preserving alternatives)
- **Private Aggregation API** — removed
- **Protected Audience (FLEDGE)** — removed
- **XML external entity parsing (`DOCTYPE SYSTEM`)** — removed (security)

### Deprecated in Chrome 143-152
- **XSLT** — deprecated (Chrome 143), removal trial (Chrome 152)
- **Intl.Locale Info getters** — deprecated (Chrome 143)
- **`GPUAdapter.isFallbackAdapter`** — deprecated (Chrome 138)
- **Media Source Extensions async range removal** — deprecated (Chrome 138)
- **Purpose: prefetch header** — removed (Chrome 140)
- **ISO-2022-JP charset auto-detection** — removed (Chrome 139)

### JavaScript Language Deprecations
- **`with` statement** — removed (never fully restored; avoid)
- **Legacy `assert` import assertions** — replaced by `with` import attributes (ES2025); update syntax.
- **`Error.captureStackTrace`** — not standard (V8-only); use `Error` subclassing + `Error.isError`.
- **`Utils`/`exports`** — Node-specific legacy; use ESM.
- **`arg`-based DOM APIs** — deprecated in favor of structured query APIs.

### Chrome Restriction Changes
- **Third-party cookies** — phased out via Storage Access API/strict policies (Chrome 141+).
- **User-Agent strings reduced** — `ch-ua` high-entropy permissions policy (Chrome 144+), legacy UA deprecated.
- **Local Network Access** — restrictions for fetch/WebSocket/WebTransport (Chrome 145-148).
- **`Direct Sockets`** — permits not yet universal; restricted to secure contexts.
- **`crossOriginIsolated`** — required for SharedArrayBuffer in all contexts.

---

## Summary Table: Key Features by Release

| Feature | Standardized | Chrome | Status |
|---------|-------------|--------|--------|
| `Object.groupBy` / `Map.groupBy` | ES2024 | 117+ | Baseline |
| `Promise.withResolvers` | ES2024 | 119+ | Baseline |
| `String.isWellFormed/toWellFormed` | ES2024 | 111+ | Baseline |
| RegExp `v` flag | ES2024 | 112+ | Baseline |
| Iterator Helpers | ES2025 | 122+ | Baseline |
| Set methods | ES2025 | 122+ | Baseline |
| `Promise.try` | ES2025 | 120+ | Baseline |
| `RegExp.escape` | ES2025 | 112+ | Baseline |
| `Float16Array` | ES2025 | 126+ | Baseline |
| Import Attributes | ES2025 | 123+ | Baseline |
| `Error.isError` | ES2026 | 130+ | Stable |
| `Math.sumPrecise` | ES2026 | 147+ | Stable |
| `Uint8Array` base64/hex | ES2026 | 140+ | Baseline |
| `Map.getOrInsert` | ES2026 | 145+ | Stable |
| `using` / `await using` | ES2026 | 139+ | Experimental |
| `Temporal` | ES2026 | 144+ | Experimental |
| `Array.fromAsync` | Stage 3 | 126+ | Experimental |

---

## Sources Consulted

- **MDN Web Docs (Context7)** — Temporal, Iterator helpers, Set methods, Promise.try, RegExp.escape, Web APIs
- **TC39 Proposals** (github.com/tc39/proposals) — all stage statuses
- **web.dev Baseline 2025 / 2026** — API stabilization lists
- **Chrome Release Notes (138-152)** — V8/engine features, deprecations, removals
- **Chrome DevRel blogs** (CSS Wrapped, web platform monthly)
- **Kevin Langley Jr. ES2024/2025/2026** — feature summaries with examples
- **MDN Browser Compatibility Data** — cross-browser support verification
