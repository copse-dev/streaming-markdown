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
npm test            # node:test via tsx — unit + CommonMark conformance
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
