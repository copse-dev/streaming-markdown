# Lazy-loading the generator's heavy dependencies (prototype)

> Status: **prototype**. Wired for `highlight.js` today; sketches the same shape
> for Mermaid. See `src/highlight.ts`, `src/highlight-hljs.ts`, and
> `src/highlight-lazy.test.ts`.
>
> The demo site (`docs/index.html`) exercises both paths live: its bundle is
> built with code splitting, so the highlight.js grammars are fetched as a
> separate chunk on the first fenced code block, and mermaid is fetched via an
> import map on the first ```mermaid fence. Status chips on the page show each
> load happening.

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

## Shiki — same registry, an async-loading backend

`@copse/streaming-markdown/highlighters/shiki` is a second highlighter backend
over the same `setCodeHighlighter` registry. It sits between the two patterns
above: like mermaid, `shiki` is an **optional peer dependency** reached only
through variable-specifier dynamic imports (the package builds without it, and
zero shiki bytes can land in the main entry — or in the subpath chunk itself);
like highlight.js, the backend highlights synchronously once ready.

Because shiki can only initialize asynchronously, `loadShiki()` is the load
seam: it awaits shiki's fine-grained core (`shiki/core` +
`createHighlighterCore` with the JavaScript regex engine — no oniguruma WASM,
no bundled-registry entry) plus the grammar and theme modules, then registers a
backend that highlights synchronously against the loaded instance. Until it
resolves, fences render as escaped plain text with the same stable
core-resolved `hljs lang-*` class, and a re-render upgrades them in place —
identical UX to lazy highlight.js. Token colors are emitted as classes (not
shiki's inline `style` attributes, which the sink sanitizer strips); see the
Shiki section of [`EXTENDING.md`](EXTENDING.md#shiki) for the styling contract
and `shikiThemeCss()`.

Mermaid is **not** bundled by this package: `mermaid-source.ts` is pure string
preparation, and the generator only emits inert scaffolding
(`<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">…`).
The heavy `mermaid` library is host-injected and rendered *after* sanitization, so
it is already lazy by construction. What the package was missing is an **official
hook** so every host stops hand-rolling the "find pending diagrams, load mermaid,
inject SVG, retry on the aggressive source candidate" dance.

The same registry shape as highlighting now ships for it:

- **`mermaid.ts` (core)** carries no mermaid code. It holds the registry
  (`setDiagramRenderer` / `getDiagramRenderer`), the `DiagramRenderer` interface,
  and `hydratePendingDiagrams(root, opts?)` — which finds every
  `mermaid-diagram--pending` container under `root`, tries the gentle then
  aggressive `mermaidSourceCandidates()` until one renders, and flips the container
  to `--rendered` (SVG injected) or `--error`.
- **`mermaid-mermaidjs.ts` (backend)** is the only module that references
  `mermaid`. It lives behind `@copse/streaming-markdown/diagrams/mermaid` and
  exports `mermaidDiagramRenderer`, `installMermaid()`, and `loadMermaid()`.
  `mermaid` is an **optional peer dependency** — the host installs it, the package
  never bundles it. The dynamic import uses a variable specifier so the package
  builds and type-checks even when the peer isn't installed.

```ts
import { hydratePendingDiagrams } from '@copse/streaming-markdown'

const { loadMermaid } = await import('@copse/streaming-markdown/diagrams/mermaid')
await loadMermaid()                 // registers the backend; library loads lazily
await hydratePendingDiagrams(messageEl) // pending → rendered SVG
```

**Trust boundary:** mermaid SVG is produced by the trusted library *after* the sink
sanitizer runs and is injected without re-sanitization (matching the existing
design invariant). A safety-conscious host can pass `hydratePendingDiagrams(root,
{ transformSvg })` to run the SVG through its own sanitizer first.

The mechanism is covered by `src/mermaid-lazy.test.ts` with a stub renderer (the
real mermaid library needs a browser DOM it can't get in jsdom); the backend module
is the thin adapter over `mermaid.render`.

## KaTeX — the same shape again, for math

Math (#70) mirrors mermaid exactly. The generator emits inert scaffolding for
every math form — ```` ```math ```` fences, `$$ … $$` / `\[ … \]` display
blocks, and `$…$` / `\(…\)` inline spans
(`math-block--pending` / `math-inline--pending`, escaped TeX source inside) —
so the KaTeX payload is never needed at render time. The *prose* delimiter
grammar (everything except the always-on ```` ```math ```` fence) is itself
gated on registration (#78): until `setMathRenderer` gets a backend — or a
host forces it with `setMathSyntax(true)` — `$…$`-style text stays ordinary
prose and output is byte-identical to a math-free build, so hosts that never
opt in pay nothing at all:

- **`math.ts` (core)** carries no KaTeX code: the registry (`setMathRenderer` /
  `getMathRenderer`), the `MathRenderer` interface, and
  `hydratePendingMath(root, opts?)` — which finds every pending block/span under
  `root`, renders it (display mode for blocks, inline for spans), and flips the
  element to `--rendered` (HTML injected) or `--error` (escaped source kept
  visible).
- **`math-katex.ts` (backend)** is the only module that references `katex`. It
  lives behind `@copse/streaming-markdown/math/katex` and exports
  `katexMathRenderer`, `installKatex()`, and `loadKatex()`. `katex` is an
  **optional peer dependency**, imported through a variable-specifier dynamic
  import so the package builds and type-checks without it.

```ts
import { hydratePendingMath } from '@copse/streaming-markdown'

const { loadKatex } = await import('@copse/streaming-markdown/math/katex')
await loadKatex()                   // registers the backend (activating the prose grammar)
await hydratePendingMath(messageEl) // pending → rendered KaTeX HTML
```

The host also loads KaTeX's stylesheet/fonts (`katex/dist/katex.min.css`).

**Trust boundary:** KaTeX HTML is injected *after* the sink sanitizer and not
re-sanitized, matching the mermaid invariant; `hydratePendingMath(root,
{ transformHtml })` is the seam for a host that wants to (and the required hook
under Trusted Types enforcement).

## Emoji shortcodes — a lazy data subpath, no peer

Emoji shortcodes (#86) reuse the split for a *data* payload rather than a
library. The optional pass and its GitHub/gemoji-aligned map live in
`src/emoji-shortcodes.ts` / `src/emoji-shortcode-map.ts` behind
`@copse/streaming-markdown/inline/emoji`; the ~50 KB alias table is pulled into a
bundle only when a host imports that entry, so a consumer that never opts in pays
zero bytes for it (`src/emoji-shortcodes.test.ts` asserts this with an esbuild
bundle of the main entry). Unlike the highlighter/mermaid/KaTeX backends there is
no optional peer dependency — the pass is pure string work built on the public
`setInlinePasses` contract, so it needs no registry in the core at all.

```ts
import { setInlinePasses } from '@copse/streaming-markdown'
import { emojiInlinePass } from '@copse/streaming-markdown/inline/emoji'

setInlinePasses([emojiInlinePass]) // `:smile:` → 😄; see EXTENDING.md#custom-inline-syntax-inline-passes
```
