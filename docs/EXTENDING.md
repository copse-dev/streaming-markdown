# Extending the renderer

The core ships **zero backend code** and stays app-independent. Every heavy or
host-specific capability is a *plug point*: a setter in the core that you
register, with any heavy backend behind its own subpath entry so bundlers drop
it unless you import it. Register each once, before your first render.

| Plug point | Register with | Optional backend entry |
| --- | --- | --- |
| HTML sanitizer | `setSanitizerBackend` | `…/sanitizers/dompurify` |
| Syntax highlighter | `setCodeHighlighter` | `…/highlighters/highlightjs` |
| Diagram renderer | `setDiagramRenderer` | `…/diagrams/mermaid` |
| Math renderer | `setMathRenderer` | `…/math/katex` |
| Custom fenced blocks | `setFenceHandler` | — (you supply the handler) |
| Custom inline syntax | `setInlinePasses` | — (you supply the pass) |
| `<a>` routing | `setLinkDecorator` | — |
| Raw `<img>` handling | `setRawImageRenderer` | — |
| Sanitizer allowlist | `setSanitizeExtension` | — |
| Link scheme allowlist | `setSafeHrefSchemes` | — |

The whole public surface is in [`src/index.ts`](../src/index.ts).

## Sanitizer backend

`sanitizeRenderedMarkdown` runs through a pluggable sanitizer backend. By default
it uses the browser's native [Sanitizer API](https://developer.mozilla.org/en-US/docs/Web/API/Element/setHTML)
(`Element.setHTML`) — a zero-dependency backend that pulls no sanitizer code into
your bundle, and needs no setup in a modern browser.

For Node/jsdom/SSR or older browsers without the native API, opt into the bundled
[DOMPurify](https://github.com/cure53/DOMPurify) backend (a peer dependency you
install). Because it lives behind its own entry point, bundlers drop DOMPurify
entirely unless you import it:

```ts
import { setSanitizerBackend } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

setSanitizerBackend(dompurifyBackend) // once, before the first render
```

You can also supply your own `SanitizerBackend`. If no backend is set and the
native API is unavailable, `sanitizeRenderedMarkdown` throws rather than emit
unsanitized HTML.

Backends may implement an optional **node path** (`SanitizerBackend.sanitizeInto`):
the sanitized nodes are placed into the target element directly — one parse per
write instead of the string path's parse -> serialize -> re-parse, and no
`innerHTML` sink at all. Both bundled backends implement it; custom backends may
omit it and sinks fall back to the string path. The node path must parse in a
neutral (body/div) context so both paths serialize identically, and if you wrap
a bundled backend to customize `sanitize`, either override `sanitizeInto`
consistently or omit it — a spread copies the bundled node path, which sinks
prefer, silently bypassing your custom `sanitize`.

## Trusted Types

The package works on pages that enforce
[Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)
(`Content-Security-Policy: require-trusted-types-for 'script'`). Every internal
DOM write goes through a single sink chokepoint that sanitizes first and then
blesses the markup through a Trusted Types policy — a lazily created policy
named `streaming-markdown` by default. This does not depend on the native
Sanitizer API: with the DOMPurify (or any custom) backend, sanitized HTML is
still assigned via `innerHTML` as policy-minted `TrustedHTML`. (When the active
backend provides the node path above, most writes bypass `innerHTML` entirely
and need no policy at all.)

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

That "already sanitized" contract is compiler-enforced: `sanitizeRenderedMarkdown`
returns a branded `SanitizedHtml` type (a `string` at runtime, exported from the
package entry), and the internal presanitized sink only accepts that brand — an
arbitrary string cannot reach it without passing through the sanitizer or an
audited internal assertion.

Edges to know about:

- **DOMPurify backend under enforcement.** DOMPurify's internal parser is
  itself a Trusted Types sink, and DOMPurify guards it with its own policy
  named `dompurify`. If your CSP restricts policy names, allowlist both:
  `trusted-types streaming-markdown dompurify` — otherwise DOMPurify cannot
  parse and every render comes out empty.
- **Your own sinks.** `renderMarkdown`/`renderStreamingMarkdown` return plain
  strings; assigning them to `innerHTML` yourself still needs your own policy.
  Prefer the exported `setSanitizedHtml(el, html)` — the package's reference
  sink — which sanitizes and blesses in one call (also the right tool inside a
  custom `FenceHandler.sync`).
- **Mermaid SVG and KaTeX HTML** bypass the markdown sanitizer by design, so
  the package never blesses them. Under enforcement, pass `transformSvg` to
  `hydratePendingDiagrams` (or `transformHtml` to `hydratePendingMath`) and
  return a `TrustedHTML` minted by your own policy
  (e.g. `DOMPurify.sanitize(svg, { RETURN_TRUSTED_TYPE: true })`).

## Syntax highlighting

Highlighting is a pluggable backend, like the sanitizer. The core carries no
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

See [`LAZY-LOADING.md`](LAZY-LOADING.md) for the bundle-size rationale and how the
same shape applies to Mermaid.

## Custom fenced blocks (fence handlers)

Mermaid and math support are built on a general **fence-handler registry**:
which HTML a fenced code block emits is looked up by the fence's language
(case-insensitive), and `mermaid` / `math` are simply the built-in entries.
Register your own to add mermaid-style blocks — graphviz, vega, and friends:

```ts
import { setFenceHandler, escapeHtml, FORMING_FENCE_PRE_CLASS } from '@copse/streaming-markdown'

setFenceHandler('graphviz', {
  // At-rest HTML for a completed ```graphviz fence. Emitted before the sanitizer
  // sink: stay inside the allowlist (or widen it via setSanitizeExtension).
  render: (code) =>
    `<div class="dot-graph dot-graph--pending"><pre class="dot">${escapeHtml(code.trimEnd())}</pre></div>`,
  // Optional: what the fence shows while still streaming (both emitters).
  forming: {
    html: (code) =>
      `<div class="dot-graph dot-graph--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="dot">${escapeHtml(code)}</pre></div>`,
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
`hydratePendingDiagrams`, math's is `hydratePendingMath`. Fences are opaque to
the parser, so handlers change emission only. `setFenceHandler('mermaid', null)`
(or `'math'`) removes a built-in and renders those fences as ordinary code
blocks.

## Math (KaTeX)

Math is first-class syntax, on by default. Four surface forms emit the same
inert two-phase scaffolding:

- ```` ```math ```` fences and `$$ … $$` / `\[ … \]` display blocks (delimiters
  on their own lines, or a one-line `$$E=mc^2$$` / `\[ E=mc^2 \]`) →
  `<div class="math-block math-block--pending"><pre class="math">…escaped TeX…</pre></div>`
- `$x$` / `$$x$$` / `\(x\)` inline math →
  `<span class="math-inline math-inline--pending">…escaped TeX…</span>`

Single-dollar math carries remark-math's currency guards — no whitespace just
inside the delimiters and no digit right after the closing `$` — so `$20 and
$30` stays prose; escaped `\$` and `$` inside code spans/fences/link
destinations never delimit. While streaming, a half-open `$$` block shows a
forming pending-math state and a half-open `$x+` holds, so raw delimiters never
flash. (Recognizing `\(…\)`/`\[…\]` is a deliberate, documented divergence from
CommonMark's escaped-punctuation reading — OpenAI models emit bracket
delimiters — gated to non-empty bodies so the spec suites still pass.)

The core ships **zero KaTeX code**: without a backend, pending math shows its
escaped TeX source. Register the KaTeX backend (an optional peer dependency you
install) and hydrate after the sink, exactly like mermaid:

```ts
import { hydratePendingMath } from '@copse/streaming-markdown'

const { loadKatex } = await import('@copse/streaming-markdown/math/katex')
await loadKatex()                  // registers the backend; library loads lazily
await hydratePendingMath(messageEl) // pending → rendered KaTeX HTML
```

Don't forget KaTeX's **stylesheet and fonts** (`katex/dist/katex.min.css`) —
the rendered HTML is unreadable without them. The backend renders with
`throwOnError: false` (invalid TeX degrades to highlighted source) and
`trust: false` (no `\href`/`\html*` commands).

**Trust boundary:** like mermaid SVG, KaTeX HTML is injected **after** the sink
sanitizer by design and is not re-sanitized. A safety-conscious host can pass
`hydratePendingMath(root, { transformHtml })` to run it through its own
sanitizer — and under Trusted Types enforcement that hook is required, exactly
like mermaid's `transformSvg`.

## Custom inline syntax (inline passes)

Fence handlers extend *block* syntax; **inline passes** extend *inline* syntax —
Pandoc-style citations `[@key]`, `==highlights==`, emoji shortcodes — without
forking the fixed inline pipeline. Register ordered passes with `setInlinePasses`:

```ts
import { setInlinePasses, escapeHtml } from '@copse/streaming-markdown'

setInlinePasses([
  {
    name: 'citations',
    stage: 'before-links', // consume [@key] before it parses as a link label (Pandoc order)
    apply: (text, ctx) =>
      text.replace(/\[@([\w.-]+)\]/g, (_m, key) =>
        // ctx.emit shields trusted HTML from later passes and the escape step.
        ctx.emit(`<cite class="citation">@${escapeHtml(key)}</cite>`)),
    // Optional streaming hold: don't flash a half-open `[@doe` mid-stream.
    holdStart: (line) => {
      const i = line.lastIndexOf('[@')
      return i === -1 ? line.length : i
    },
  },
])
```

- **Stage.** `before-links` (default) runs after emphasis/strikethrough and before
  markdown-link resolution — required for bracket syntaxes that must beat link
  labels. `after-links` runs last, over text with `<a>`/`<code>` already rendered.
- **Shielded and escaped for you.** A pass only sees text *outside* rendered
  `<code>`/`<a>`/`<img>` spans, and backslash escapes are already inert — so
  `` `[@key]` `` and `\[@key]` never fire. Emit HTML through `ctx.emit(html)`: it's
  parked behind an inert placeholder and restored *after* the escape step, so your
  markup survives instead of being escaped away.
- **Streaming hold.** An optional `holdStart` keeps a half-open construct (`[@doe`,
  `==foo`) from flashing raw mid-stream — the same mechanism as the built-in
  strikethrough hold.
- **The sanitizer is still the gate.** Emitted tags/attributes outside the core
  allowlist need `setSanitizeExtension` (below).

With no passes registered the pipeline is unchanged and output is byte-identical.

## Link routing (`LinkDecorator`)

A `LinkDecorator` returns the attribute string appended after `href` on every
rendered `<a>` — the seam for host-specific routing (open-in-new-tab, in-app
navigation, `rel` policy) without hard-coding it into the parser:

```ts
import { setLinkDecorator } from '@copse/streaming-markdown'

setLinkDecorator(({ href, isWorkspace, title }) =>
  isWorkspace ? ` data-nav="${href}"` : ` target="_blank" rel="noopener noreferrer"`,
)
```

Attribute *names* a decorator emits must be in the escape and sink allowlists, or
they are stripped — widen both to match a custom decorator's vocabulary.

## Raw images

The core is image-agnostic: every raw `<img>` is escaped by default. A host that
wants to allow specific images (e.g. resolving an app artifact URL to an inert
placeholder) injects a `RawImageRenderer` with `setRawImageRenderer`; return the
replacement HTML, or `null` to leave the tag escaped. `normalizeHostImagePath`
is a companion that reduces a volatile `src` (absolute container paths, per-session
download URLs) to a stable relative path so rendered output stays deterministic
across machines.

## Link scheme allowlist

Link destinations are validated against a scheme allowlist
(`DEFAULT_SAFE_HREF_SCHEMES`: `http`, `https`, `mailto`, `tel`, `sms`, `ftp`,
`ftps`, plus scheme-less relative/fragment/path forms); any other scheme —
including `javascript:` and `data:` — is dropped. Override it with
`setSafeHrefSchemes([...])` (case-insensitive; pass `null` to restore the
default). Narrowing the list is always safe; only widen it with schemes that are
inert as an `href`, never `javascript`/`data`/`vbscript`/`file`.

## Widening the sanitizer allowlist

The sink allowlist in `sanitize.ts` mirrors exactly what the renderer emits and
is the security gate. If a host plug-in emits tags/attributes outside it (a custom
fence handler's scaffolding, a decorator's attribute, an artifact `<img>`), widen
the sink with `setSanitizeExtension` — and keep the additions as narrow as the
injected output. `onElement` runs for every kept element so a host can lock down
its own tags.

## Styling

The renderer emits a documented set of class hooks (`stream-pending-*`,
`contains-task-list`, `mermaid-diagram`, `math-block` / `math-inline` (with
`--pending` / `--rendered` / `--error` states), `hljs-*`, … — see the class contract in
[`ARCHITECTURE.md`](ARCHITECTURE.md)) but ships no styles by default, so it stays
host-independent. Two optional stylesheets are provided; both scope every rule
under a `.streaming-markdown` class, so add that class to the element you render
into:

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
header comment in [`styles/default.css`](../styles/default.css) for the full list
(`--sm-space-sm`, `--sm-border`, `--sm-accent`, `--sm-code-bg`, …).

The stylesheets are authored with native CSS nesting; bundle with a target that
supports it (any current engine) or let your bundler lower it.
