# @copse/streaming-markdown

**Markdown that renders as it arrives.** Two emitters for the same content
stream — a pure `string→HTML` function for at-rest rendering, and an incremental
DOM renderer that reveals partial markdown as tokens arrive without flashing raw
syntax. CommonMark + GFM, built for LLM/agent chat UIs, but host-independent.

**▶ [Live demo](https://copse-dev.github.io/streaming-markdown/)** — watch both emitters stream the same content side by side.

```bash
npm install @copse/streaming-markdown
```

## Quick start

**At rest** — render a complete string, then sanitize at the sink:

```ts
import { renderMarkdown, sanitizeRenderedMarkdown } from '@copse/streaming-markdown'

// renderMarkdown returns UNTRUSTED HTML — sanitize at every innerHTML sink.
el.innerHTML = sanitizeRenderedMarkdown(renderMarkdown('# Hi\n\n**bold** and ~~strike~~'))
```

**Streaming** — feed the growing string on each token. The string emitter is the
simplest; the DOM emitter patches incrementally instead of replacing `innerHTML`:

```ts
import { StreamingMarkdownRenderer } from '@copse/streaming-markdown'

const renderer = new StreamingMarkdownRenderer(el)
for await (const chunk of stream) {
  accumulated += chunk
  renderer.update(accumulated) // incremental DOM patch, pending blocks styled while they form
}
```

## Highlights

- **Streaming-safe.** Pending block states show partial structure (tables, lists,
  code, diagrams) without flashing raw syntax; a re-render upgrades in place.
- **CommonMark + GFM** — tables, task lists, strikethrough, autolinks, indented
  and fenced code. Tracked against the spec's conformance suite.
- **Sanitize at the sink.** Rendered HTML is treated as untrusted and links are
  scheme-validated; the sink sanitizer is the security gate.
- **Light by default.** The only runtime dependency is `entities`. highlight.js,
  DOMPurify, and mermaid are **optional and lazy** — never in your bundle unless
  you opt in. See [`docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md).
- **Pluggable everything** — sanitizer, syntax highlighter, mermaid & custom
  fenced blocks, custom inline syntax (citations, highlights), and `<a>` routing
  are all injectable.

## Extending

The sanitizer, syntax highlighter, diagram/fenced-block renderers, custom inline
syntax, link routing, and raw-image handling are all plug points — register a
backend once and it stays out of your bundle until you do. The full guide, with
code for each, is in **[`docs/EXTENDING.md`](docs/EXTENDING.md)**:

```ts
import { setSanitizerBackend } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

setSanitizerBackend(dompurifyBackend) // e.g. for Node/jsdom/SSR
```

## Styling

The renderer emits documented class hooks but ships no styles by default.
Two optional stylesheets are provided (`styles/core.css`, structural only;
`styles/default.css`, a batteries-included theme); both scope every rule under a
`.streaming-markdown` class:

```ts
import '@copse/streaming-markdown/styles/default.css'
el.classList.add('streaming-markdown')
```

Retheme via `--sm-*` custom properties. Full details — class contract, the CSS
variables, and native-nesting note — are in [`docs/EXTENDING.md`](docs/EXTENDING.md#styling).

## Documentation

- **[`docs/EXTENDING.md`](docs/EXTENDING.md)** — every plug point (sanitizer,
  highlighter, custom fenced blocks, link routing, images, scheme allowlist) and styling.
- **[`docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md)** — why the heavy deps are
  optional and lazy, and how the code-split loading works.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — design invariants, the
  two-emitter streaming architecture, and the regression/conformance suite.

## Development

```bash
npm install
npm run typecheck   # tsc (strict, exactOptionalPropertyTypes)
npm test            # node:test via tsx — unit + CommonMark & GFM conformance
npm run build       # emit dist/ (ESM JS + .d.ts)
```
