# Lazy-loading the generator's heavy dependencies (prototype)

> Status: **prototype**. Wired for `highlight.js` today; sketches the same shape
> for Mermaid. See `src/highlight.ts`, `src/highlight-hljs.ts`, and
> `src/highlight-lazy.test.ts`.

## The problem

`renderMarkdown()` (the "generator") is a synchronous string→HTML function. Its
only heavy runtime dependency is **highlight.js** — the core plus a dozen language
grammars. Because `render-blocks.ts` imported `highlight.ts`, which statically
imported highlight.js, the whole grammar payload landed in **every** consumer's
main bundle, even one that never renders a fenced code block.

Measured with esbuild (`--bundle --minify --format=esm`) on `dist/`:

| Bundle                                    | Size    | Contains highlight.js? |
| ----------------------------------------- | ------- | ---------------------- |
| Main entry (`index.js`), before           | ~164 KB | yes (unconditionally)  |
| Main entry (`index.js`), after            | ~92 KB  | **no**                 |
| `highlighters/highlightjs` chunk (lazy)   | ~71 KB  | yes (fetched on demand) |

So ~71 KB — the grammars — now loads only when a host asks for highlighting.

## The shape: a pluggable backend, mirroring the sanitizer split

This reuses the exact pattern the sanitizer already uses (`setSanitizerBackend` +
the `@copse/streaming-markdown/sanitizers/dompurify` subpath):

- **`highlight.ts` (core)** carries *no* highlight.js code. It keeps only the
  cheap string work — language aliases, the `KNOWN_LANGUAGES` set, and
  `fenceCodeClass` — and a registry: `setCodeHighlighter(backend | null)` /
  `getCodeHighlighter()`. With no backend registered, `highlightFenceCode` returns
  **escaped plain text**.
- **`highlight-hljs.ts` (backend)** is the only module that imports highlight.js.
  It registers the grammars and exports `highlightjsHighlighter`,
  `installHighlightjs()`, and `loadHighlightjs()`. It lives behind the
  `@copse/streaming-markdown/highlighters/highlightjs` subpath, so a bundler drops
  it unless the host references that entry.

### Why language *resolution* stays in the core

`fenceCodeClass('ts')` returns `hljs lang-typescript` **before** the backend loads
and the identical string **after**. That stability matters for streaming: the core
renders a code fence as plain escaped text with the final class immediately, and a
later re-render (once the grammar chunk arrives) only swaps the *interior* to token
spans — the `<pre><code class>` element never churns. `KNOWN_LANGUAGES` in the core
must stay in sync with the grammars the backend registers.

## Using it

Eager (highlighting from first paint — pulls the chunk into your bundle):

```ts
import { setCodeHighlighter } from '@copse/streaming-markdown'
import { highlightjsHighlighter } from '@copse/streaming-markdown/highlighters/highlightjs'

setCodeHighlighter(highlightjsHighlighter) // once, before the first render
```

Lazy (the grammars are a separate chunk, fetched only when this runs):

```ts
// e.g. on the first fenced block seen, or during an idle callback
const { loadHighlightjs } = await import('@copse/streaming-markdown/highlighters/highlightjs')
await loadHighlightjs() // calls setCodeHighlighter internally

// re-render the message so already-rendered fences upgrade from plain → highlighted
rerender()
```

Until either runs, code fences render as safe, escaped plain text with the correct
`hljs lang-*` class.

## Mermaid — already lazy, same hook shape

Mermaid is **not** bundled by this package: `mermaid-source.ts` is pure string
preparation, and the generator only emits inert scaffolding
(`<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">…`).
The heavy `mermaid` library is host-injected and rendered *after* sanitization, so
it is lazy by construction — the host decides when to
`const mermaid = await import('mermaid')` and hydrate the pending diagrams.

If we ever want the generator to *trigger* that load (as it now can for
highlighting), the same registry shape drops in: a `setDiagramRenderer(backend)`
hook the DOM emitter calls when it commits a `mermaid` fence, with a
`loadMermaid()` convenience behind a `@copse/streaming-markdown/diagrams/mermaid`
subpath. Not built here — the highlight.js path is the working proof of the
pattern.
