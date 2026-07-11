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

**At rest** — `renderMarkdown` is the safe, default entry point: its output has
already passed through the sink sanitizer, so it drops straight into `innerHTML`
(or `setSanitizedHtml`, which is also Trusted Types-safe):

```ts
import { renderMarkdown, setSanitizedHtml } from '@copse/streaming-markdown'

setSanitizedHtml(el, renderMarkdown('# Hi\n\n**bold** and ~~strike~~'))
// el.innerHTML = renderMarkdown('…') is also safe — the output is sanitized.
```

Because sanitizing builds a DOM, `renderMarkdown` needs a sanitizer backend (the
browser's native Sanitizer API by default, or a registered one such as
[`…/sanitizers/dompurify`](docs/EXTENDING.md)); with neither available it **throws**
rather than return unsafe HTML.

Working with strings end-to-end (SSR, snapshots, non-DOM pipelines) with no
backend? Use `renderMarkdownUnsafe` — the zero-dependency, DOM-free path. It
returns **untrusted** HTML, so pass it through `sanitizeRenderedMarkdown` before
it reaches any `innerHTML` sink you manage yourself.

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
  code, diagrams, math) without flashing raw syntax; a re-render upgrades in place.
- **CommonMark + GFM** — tables, task lists, strikethrough, autolinks,
  footnotes (`[^1]`), GitHub alerts (`> [!NOTE]`), indented and fenced code.
  Tracked against the spec's conformance suite.
- **First-class math.** ```` ```math ```` fences, `$$…$$` and `\[…\]` display
  blocks (the OpenAI delimiter style), and `$…$` / `\(…\)` inline math with
  currency guards (`$20 and $30` stays prose) — rendered lazily via KaTeX,
  streamed without delimiter flash. The prose delimiters are opt-in per render
  via `{ mathSyntax: true }`; until then output stays byte-identical to a
  math-free build (the ```` ```math ```` fence renders regardless).
  See [Math in `docs/EXTENDING.md`](docs/EXTENDING.md#math-katex).
- **Sanitize at the sink.** Rendered HTML is treated as untrusted and links are
  scheme-validated; the sink sanitizer is the security gate. Raw HTML is
  **passed through by default** (`htmlPolicy: 'passthrough'`) and the sink
  sanitizer is the sole arbiter — allowlisted tags render as elements, everything
  else (including `<script>`) is stripped/unwrapped; pass `htmlPolicy: 'escape'`
  in the render config to literalize raw HTML instead, e.g. if you write
  the renderer string to a sink without sanitizing. An opt-in
  **link/image origin allowlist** (`linkImagePolicy`) layers on top —
  restrict which origins links/images may point at, rewrite/neutralize the rest,
  and strip base64 `data:` images — off by default, byte-identical until you set
  it. See [Link/image origin policy in `docs/EXTENDING.md`](docs/EXTENDING.md#linkimage-origin-policy).
  The full security model, threat model, and hardening knobs are in
  [`docs/SECURITY.md`](docs/SECURITY.md).
- **Zero runtime dependencies.** The core carries no required dependency. HTML
  character references decode against a built-in set (the 252 classic HTML4 named
  references plus all numeric references) that covers essentially everything real
  markdown emits; the full ~2,100-entry HTML5 table (~23 KB gzip) is opt-in via
  `browserEntityDecoder` (zero bundle cost in the DOM) or the
  `@copse/streaming-markdown/entities/full` entry — see
  [Entity decoding in `docs/EXTENDING.md`](docs/EXTENDING.md#entity-decoding).
  highlight.js (or Shiki — both ship as backends), DOMPurify, mermaid, and KaTeX
  are **optional and lazy** — never in your bundle unless you opt in. See
  [`docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md).
- **Pluggable everything** — sanitizer, syntax highlighter, mermaid & math &
  custom fenced blocks, custom inline syntax (citations, highlights), and `<a>`
  routing are all injectable. Emoji shortcodes (`:smile:` → 😄) ship as an
  optional inline pass behind `@copse/streaming-markdown/inline/emoji` — a
  GitHub/gemoji-aligned map, zero bytes in your bundle unless imported.
- **Optional reveal smoothing.** An opt-in helper
  (`@copse/streaming-markdown/smoothing`) steadies chunky token arrival into a
  smooth character-cadence reveal by throttling the *input* fed to
  `renderer.update()`. Off by default and zero bytes unless imported; honours
  `prefers-reduced-motion` and flushes immediately on stream end. See
  [Input smoothing in `docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md#input-smoothing--an-opt-in-reveal-cadence-84).

## Extending

The sanitizer, syntax highlighter, diagram/fenced-block renderers, custom inline
syntax, link routing, and raw-image handling are all plug points — register a
backend once and it stays out of your bundle until you do. The full guide, with
code for each, is in **[`docs/EXTENDING.md`](docs/EXTENDING.md)**:

```ts
import { renderMarkdown } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

// Pass the backend in the per-render config — e.g. for Node/jsdom/SSR.
renderMarkdown(md, { sanitizerBackend: dompurifyBackend })
```

Pages that enforce [Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)
(`require-trusted-types-for 'script'`) are supported out of the box with any
backend — see [Trusted Types in `docs/EXTENDING.md`](docs/EXTENDING.md#trusted-types)
for the CSP policy names and the `trustedTypesPolicy` config field.

Chinese / Japanese / Korean output has an opt-in entry too: spread
`cjkFriendlyConfig` from `@copse/streaming-markdown/cjk` into the render config to
make emphasis and bare autolinks behave
around full-width punctuation (`**「強調」**`, `https://example.com。`), and the
optional `styles/cjk.css` carries the line-break / spacing CSS the host owns —
see [CJK / East-Asian text](docs/EXTENDING.md#cjk--east-asian-text). Both are
off by default; Latin output is byte-identical.

## Styling

The renderer emits documented class hooks but ships no styles by default.
Optional stylesheets are provided (`styles/core.css`, structural only;
`styles/default.css`, a batteries-included theme; `styles/cjk.css`, opt-in
East-Asian line-break / spacing); each scopes every rule under a
`.streaming-markdown` class:

```ts
import '@copse/streaming-markdown/styles/default.css'
el.classList.add('streaming-markdown')
```

Retheme via `--sm-*` custom properties. Full details — class contract, the CSS
variables, and native-nesting note — are in [`docs/EXTENDING.md`](docs/EXTENDING.md#styling).

## Documentation

- **[`docs/REACT.md`](docs/REACT.md)** — using it from React: at-rest and
  incremental-streaming components, SSR, and migrating from `react-markdown`.
- **[`docs/EXTENDING.md`](docs/EXTENDING.md)** — every plug point (sanitizer,
  highlighter, custom fenced blocks, link routing, images, scheme allowlist) and styling.
- **[`docs/RECIPES.md`](docs/RECIPES.md)** — UI recipes: how to add copy
  buttons (and similar widgets) to code blocks without fighting the streaming morph.
- **[`docs/LAZY-LOADING.md`](docs/LAZY-LOADING.md)** — why the heavy deps are
  optional and lazy, and how the code-split loading works.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — design invariants, the
  two-emitter streaming architecture, and the regression/conformance suite.
- **[`docs/SECURITY.md`](docs/SECURITY.md)** — the sanitize-at-the-sink security
  model, a threat model, trust boundaries, and hardening knobs.

## Development

```bash
npm install
npm run typecheck   # tsc (strict, exactOptionalPropertyTypes)
npm test            # node:test via tsx — unit + CommonMark & GFM conformance
npm run build       # emit dist/ (ESM JS + .d.ts)
npm run test:e2e    # Trusted Types enforcement e2e in real Chromium (skips without a browser)
npm run bench:browser  # sink-path throughput in real Chromium, incl. a TT-enforced page
```
