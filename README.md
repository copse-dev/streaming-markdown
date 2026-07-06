# @copse/streaming-markdown

A streaming-capable CommonMark renderer with two emitters: a pure string→HTML
function for at-rest rendering, and an incremental DOM renderer that reveals
partial markdown as tokens arrive without flashing raw syntax. Built for
LLM/agent chat UIs, but host-independent.

```bash
npm install @copse/streaming-markdown
```

```ts
import { renderMarkdown, sanitizeRenderedMarkdown } from '@copse/streaming-markdown'

// renderMarkdown returns UNTRUSTED HTML — sanitize at every innerHTML sink.
el.innerHTML = sanitizeRenderedMarkdown(renderMarkdown('# Hi\n\n**bold** and ~~strike~~'))
```

Indented code blocks are supported by default (`    code` → `<pre><code>`); pass
`renderMarkdown(md, { indentedCode: false })` to opt out and render those lines as
prose paragraphs instead. See the design note in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Sanitizer backend

`sanitizeRenderedMarkdown` runs through a **pluggable sanitizer backend**. By
default it uses the browser's native [Sanitizer API](https://developer.mozilla.org/en-US/docs/Web/API/Element/setHTML)
(`Element.setHTML`) — a zero-dependency backend that pulls no sanitizer code into
your bundle. To use it, no setup is needed in a modern browser.

For Node/jsdom/SSR or older browsers without the native API, opt into the bundled
[DOMPurify](https://github.com/cure53/DOMPurify) backend (a peer dependency you
install yourself). Because it lives behind its own entry point, bundlers drop
DOMPurify entirely unless you import it:

```ts
import { setSanitizerBackend } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

setSanitizerBackend(dompurifyBackend) // once, before the first render
```

You can also supply your own `SanitizerBackend`. If no backend is set and the
native API is unavailable, `sanitizeRenderedMarkdown` throws rather than emit
unsanitized HTML.

### Trusted Types

The package works on pages that enforce
[Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)
(`Content-Security-Policy: require-trusted-types-for 'script'`). Every internal
DOM write goes through a single sink chokepoint that sanitizes first and then
blesses the markup through a Trusted Types policy — a lazily created policy
named `streaming-markdown` by default. This does not depend on the native
Sanitizer API: with the DOMPurify (or any custom) backend, sanitized HTML is
still assigned via `innerHTML` as policy-minted `TrustedHTML`.

If your CSP restricts policy names (`trusted-types` directive), either
allowlist `streaming-markdown` or inject your own policy:

```ts
import { setTrustedTypesPolicy } from '@copse/streaming-markdown'

setTrustedTypesPolicy(
  window.trustedTypes.createPolicy('my-app#markdown', { createHTML: (s) => s }),
)
```

The injected policy always receives markup that has already been through
`sanitizeRenderedMarkdown`, so an identity `createHTML` is sound — the hook
exists for CSP policy-name control, not to replace the sanitizer.

Two edges to know about:

- **Your own sinks.** `renderMarkdown`/`renderStreamingMarkdown` return plain
  strings; assigning them to `innerHTML` yourself still needs your own policy.
  Prefer the exported `setSanitizedHtml(el, html)` — the package's reference
  sink — which sanitizes and blesses in one call (also the right tool inside a
  custom `FenceHandler.sync`).
- **Mermaid SVG** bypasses the markdown sanitizer by design, so the package
  never blesses it. Under enforcement, pass `transformSvg` to
  `hydratePendingDiagrams` and return a `TrustedHTML` minted by your own policy
  (e.g. `DOMPurify.sanitize(svg, { RETURN_TRUSTED_TYPE: true })`).

Streaming, syntax highlighting, Mermaid source preparation, and an injectable
`LinkDecorator` for host-specific `<a>` routing are also exported — see the
public surface in [`src/index.ts`](src/index.ts).

### Syntax highlighting (lazy backend)

Highlighting is a **pluggable backend**, like the sanitizer. The core carries no
[highlight.js](https://highlightjs.org/) code and renders fenced code as escaped
plain text (with the correct `hljs lang-*` class) until you register one — so
highlight.js is only in your bundle if you ask for it:

```ts
import { setCodeHighlighter } from '@copse/streaming-markdown'
import { highlightjsHighlighter } from '@copse/streaming-markdown/highlighters/highlightjs'

setCodeHighlighter(highlightjsHighlighter) // once, before the first render
```

Or lazily — the grammars load as a separate chunk only when first needed, and a
re-render upgrades already-rendered fences from plain to highlighted:

```ts
const { loadHighlightjs } = await import('@copse/streaming-markdown/highlighters/highlightjs')
await loadHighlightjs()
```

See [`docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md) for the bundle-size rationale
and how the same shape applies to Mermaid.

### Custom fenced blocks (fence handlers)

Mermaid support is built on a general **fence-handler registry**: which HTML a
fenced code block emits is looked up by the fence's language (case-insensitive),
and `mermaid` is simply the built-in entry. Register your own to add
mermaid-style blocks — math, graphviz, vega, and friends:

```ts
import { setFenceHandler, escapeHtml, FORMING_FENCE_PRE_CLASS } from '@copse/streaming-markdown'

setFenceHandler('math', {
  // At-rest HTML for a completed ```math fence. Emitted before the sanitizer
  // sink: stay inside the allowlist (or widen it via setSanitizeExtension).
  render: (code) =>
    `<div class="math-block math-block--pending"><pre class="math">${escapeHtml(code.trimEnd())}</pre></div>`,
  // Optional: what the fence shows while still streaming (both emitters).
  forming: {
    html: (code) =>
      `<div class="math-block math-block--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="math">${escapeHtml(code)}</pre></div>`,
    // Optional incremental DOM update; default = sanitized innerHTML replace.
    sync: (container, code) => {
      /* patch container in place */
    },
  },
})
```

The pattern is two-phase, like mermaid: the handler emits inert, escaped
*scaffolding* at render time, and your app hydrates it into rich output (SVG,
KaTeX, …) **after** the HTML is sanitized at the sink — mermaid's hydrator is
`hydratePendingDiagrams`. Fences are opaque to the parser, so handlers change
emission only. `setFenceHandler('mermaid', null)` removes the built-in and
renders mermaid fences as ordinary code blocks.

Link destinations are validated against a scheme allowlist
(`DEFAULT_SAFE_HREF_SCHEMES`: `http`, `https`, `mailto`, `tel`, `sms`, `ftp`,
`ftps`, plus scheme-less relative/fragment/path forms); any other scheme —
including `javascript:` and `data:` — is dropped. Override it with
`setSafeHrefSchemes([...])` (case-insensitive; pass `null` to restore the
default). Narrowing the list is always safe; only widen it with schemes that are
inert as an `href`, never `javascript`/`data`/`vbscript`/`file`.

## Styling

The renderer emits a documented set of class hooks (`stream-pending-*`,
`contains-task-list`, `mermaid-diagram`, `hljs-*`, … — see the class contract in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) but ships no styles by default, so
it stays host-independent. Two optional stylesheets are provided; both scope every
rule under a `.streaming-markdown` class, so add that class to the element you
render into:

```ts
import '@copse/streaming-markdown/styles/default.css'
el.classList.add('streaming-markdown')
```

- **`styles/core.css`** — structural only: the rules the emitter's output needs to
  render *correctly* regardless of theme (pending-state whitespace, task-list
  marker suppression, code-block whitespace, layout-blowout guards). No colours,
  spacing, or typography. Pair it with your own theme.
- **`styles/default.css`** — imports `core.css` and adds a batteries-included look
  (spacing, typography, tables, links, and a highlight.js VS Code Dark+ palette).

Retheme `default.css` by setting `--sm-*` custom properties on `.streaming-markdown`
(or any ancestor) — each has a fallback, so the sheet also stands alone. See the
header comment in [`styles/default.css`](styles/default.css) for the full list
(`--sm-space-sm`, `--sm-border`, `--sm-accent`, `--sm-code-bg`, …).

The stylesheets are authored with native CSS nesting; bundle with a target that
supports it (any current engine) or let your bundler lower it.

## Development

```bash
npm install
npm run typecheck   # tsc (strict, exactOptionalPropertyTypes)
npm test            # node:test via tsx — unit + CommonMark & GFM conformance
npm run build       # emit dist/ (ESM JS + .d.ts)
```

## Architecture

Hand-rolled renderer in `renderer.ts`. At-rest rendering routes through
`tokenizeBlocks()` → `renderBlocks()` (`render-blocks.ts`); block/inline tokenizers in
`block-tokenizer.ts`, `inline-emphasis.ts`, and `streaming-split.ts` also drive streaming
hold decisions. It treats the CommonMark spec as the reference for block/inline
structure and grows toward it incrementally (see the conformance baseline in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## Documentation

The design invariants (sanitize-at-the-sink, package boundary, streaming hold,
raw-HTML policy, …), the two-emitter streaming architecture, and the full
regression/conformance suite are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
