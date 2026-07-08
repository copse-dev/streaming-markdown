# Extending the renderer

The core ships **zero backend code** and stays app-independent. Every heavy or
host-specific capability is a *plug point*: a setter in the core that you
register, with any heavy backend behind its own subpath entry so bundlers drop
it unless you import it. Register each once, before your first render.

| Plug point | Register with | Optional backend entry |
| --- | --- | --- |
| HTML sanitizer | `setSanitizerBackend` | `…/sanitizers/dompurify` |
| Syntax highlighter | `setCodeHighlighter` | `…/highlighters/highlightjs`, `…/highlighters/shiki` |
| Diagram renderer | `setDiagramRenderer` | `…/diagrams/mermaid` |
| Math renderer | `setMathRenderer` | `…/math/katex` |
| Math prose syntax (override) | `setMathSyntax` | — |
| Custom fenced blocks | `setFenceHandler` | — (you supply the handler) |
| Custom inline syntax | `setInlinePasses` | — (you supply the pass) |
| CJK-friendly emphasis / autolinks | `setCjkFriendly` | `…/cjk` |
| `<a>` routing | `setLinkDecorator` | — |
| Raw `<img>` handling | `setRawImageRenderer` | — |
| Sanitizer allowlist | `setSanitizeExtension` | — |
| Link scheme allowlist | `setSafeHrefSchemes` | — |
| Link/image origin policy | `setLinkImagePolicy` | — |

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

### Shiki

A second bundled backend uses [Shiki](https://shiki.style/) (an optional peer
dependency you install, like mermaid — never bundled by this package). Shiki can
only initialize asynchronously, so the backend is an async-load seam over the
synchronous `CodeHighlighter` contract: fences render as escaped plain text
(with the stable core-resolved `lang-*` class) until the load resolves, and a
re-render upgrades them in place — the same UX as lazy highlight.js:

```ts
const { loadShiki, shikiThemeCss } = await import('@copse/streaming-markdown/highlighters/shiki')
await loadShiki() // loads shiki/core + grammars + theme, registers the backend
document.head.insertAdjacentHTML('beforeend', `<style>${shikiThemeCss()}</style>`)
rerender() // already-rendered fences upgrade from plain → highlighted
```

`installShiki()` is the eager form: it registers the backend synchronously and
starts the library load in the background (`await loadShiki()` to observe
completion or a missing-peer failure).

**Styling.** Shiki's stock output colors tokens with inline `style` attributes,
which the sink sanitizer strips (`style` stays off the allowlist — it would hand
markdown authors arbitrary CSS). The backend instead renders tokens itself with
*class*-based colors — `<span class="shiki-f97583">` plus
`shiki-italic`/`shiki-bold`/… — which pass the existing `class` allowlist, and
`shikiThemeCss()` returns the theme's tiny stylesheet (one rule per palette
color) to inject once, any way your app ships CSS. Tokens in the theme's default
foreground are emitted bare, so your code-block text color still applies.

**Theme and grammars.** The default is the `github-dark` theme and grammars
covering the core `KNOWN_LANGUAGES` set (`shellscript` provides both the `bash`
and `shell` ids). The first `loadShiki`/`installShiki` call can override both:

```ts
await loadShiki({ theme: 'vitesse-light', langs: ['typescript', 'python'] })
```

`theme` is a bundled shiki theme name or a pre-resolved theme registration
object; `langs` are shiki grammar names. Two behavioural mismatches with the
hljs backend: shiki has no auto-detection, so fences with an *empty* info string
stay plain text, and grammars you drop from `langs` fall back to plain text even
though the core still resolves their ids.

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

Math is first-class syntax. Four surface forms emit the same inert two-phase
scaffolding:

- ```` ```math ```` fences and `$$ … $$` / `\[ … \]` display blocks (delimiters
  on their own lines, or a one-line `$$E=mc^2$$` / `\[ E=mc^2 \]`) →
  `<div class="math-block math-block--pending"><pre class="math">…escaped TeX…</pre></div>`
- `$x$` / `$$x$$` / `\(x\)` inline math →
  `<span class="math-inline math-inline--pending">…escaped TeX…</span>`

**The prose grammar is off until you register a renderer (#78).** `$…$`-style
delimiters in ordinary prose have realistic non-math readings (`set $PATH$
properly`, prices), so by default they stay literal text and output is
byte-identical to a math-free build — no pending scaffolding that nothing will
hydrate. `setMathRenderer(backend)` (which `installKatex()` / `loadKatex()`
call for you) turns the prose grammar on; `setMathRenderer(null)` restores the
literal reading. `setMathSyntax(true | false | null)` is the explicit override:
`true` forces the grammar on without a renderer (scaffolding-only hosts that
hydrate elsewhere), `false` forces it off even with a renderer (KaTeX for
fences only), `null` — the default — defers to renderer registration. Set it
once, before the first render; a mid-stream flip only affects regions rendered
afterwards, so recreate the streaming renderer for a clean switch. The
explicitly labeled ```` ```math ```` **fence is never gated** — like a
```` ```mermaid ```` fence, it is unambiguous author intent.

With the grammar on: single-dollar math carries remark-math's currency
guards — no whitespace just inside the delimiters and no digit right after the
closing `$` — so `$20 and $30` stays prose; escaped `\$` and `$` inside code
spans/fences/link destinations never delimit. While streaming, a half-open
`$$` block shows a forming pending-math state and a half-open `$x+` holds, so
raw delimiters never flash. (Recognizing `\(…\)`/`\[…\]` is a deliberate,
documented divergence from CommonMark's escaped-punctuation reading — OpenAI
models emit bracket delimiters — gated to non-empty bodies so the spec suites
still pass.)

The core ships **zero KaTeX code**: without a backend, pending math shows its
escaped TeX source. Register the KaTeX backend (an optional peer dependency you
install) and hydrate after the sink, exactly like mermaid — one call activates
the grammar and the renderer together:

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

**Or use the shipped emoji pass.** Emoji shortcodes (`:smile:` → 😄) are the same
recipe promoted to a built-in, optional pass — so hosts don't hand-roll the
shortcode map. It lives behind its own subpath (zero bytes in the main bundle
unless imported) and ships a GitHub/gemoji-aligned table so `:shortcode:`s an LLM
emits resolve to the glyph GitHub would render:

```ts
import { setInlinePasses } from '@copse/streaming-markdown'
import { emojiInlinePass } from '@copse/streaming-markdown/inline/emoji'

setInlinePasses([emojiInlinePass]) // once, before the first render
```

It obeys the full contract for free: `` `:smile:` `` and `\:smile:` stay literal,
unknown codes pass through, and a half-typed `:smi` holds mid-stream. Extend or
replace the table with `createEmojiInlinePass(customMap)`, or read the shipped
`emojiShortcodes` map from the same entry.

## CJK / East-Asian text

East-Asian (Chinese / Japanese / Korean) output splits cleanly into two layers,
and the honest scope split matters: **most of it is the host's CSS, and only a
small, real slice belongs in the renderer.**

**Renderer layer — opt-in JS behind `@copse/streaming-markdown/cjk`.** CommonMark's
emphasis *flanking* rules count full-width / ideographic punctuation (`「」`,
`。`, `！`, `（）`, …) as ordinary Unicode punctuation, so a `**` between a CJK
character and one of those marks fails to flank and the emphasis never pairs —
`これは**「強調」**です` stays literal. That is a documented CommonMark
limitation, not a bug in this renderer (the reference implementation produces the
same literal output), so it is an **extension**, off by default. A post-process
inline pass cannot fix it — by the time passes run, the `**` have already been
left as text — so it is a default-off hook in the flanking classifier instead.
Turn it on (once, before the first render) and it also stops a run-together bare
autolink at the first full-width mark (`https://example.com。次` → link + prose):

```ts
import { setCjkFriendly } from '@copse/streaming-markdown/cjk'

setCjkFriendly(true) // markdown-cjk-friendly emphasis + autolink boundaries
```

Like the other optional backends, the range table lives behind its own entry —
nothing is pulled into your bundle unless you import `…/cjk`. With it off (the
default), Latin output and the CommonMark/GFM conformance suites are
byte-identical. `setCjkFriendly(false)` restores stock flanking.

**Host layer — CSS.** Line breaking (ideographs wrap between any two characters,
Kinsoku start/end constraints), inter-script spacing (the gap between CJK and
Latin/numbers), and full-width-punctuation kerning are **presentation the host
owns** — the renderer emits the same structural HTML for every script and does
*not* guess a language. Ship the ready-made optional sheet and tell the browser
the language:

```ts
import '@copse/streaming-markdown/styles/cjk.css'
el.lang = 'ja' // or 'zh' / 'ko'; or add class 'sm-cjk' to the container
```

`styles/cjk.css` is not imported by `core.css` / `default.css` and is pure CSS
(`word-break`, `line-break: strict`, and progressive `text-autospace` /
`text-spacing-trim`), scoped under `.streaming-markdown` and gated on `:lang()`
or a `.sm-cjk` class hook — see the header comment in the file. It needs no JS,
and the JS entry needs no CSS; use either, both, or neither.

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

## Link/image origin policy

The scheme allowlist above decides which URL *schemes* may render. A separate,
**opt-in** origin policy decides which *origins* an already-scheme-safe link or
image may point at — the turnkey equivalent of hand-rolling an allowlist at your
sink. It is **off by default**: with no policy installed, output is
byte-identical to today.

```ts
import { setLinkImagePolicy } from '@copse/streaming-markdown'

setLinkImagePolicy({
  allowedLinkPrefixes: ['https://docs.example.com/', 'https://github.com/acme/'],
  allowedImagePrefixes: ['https://cdn.example.com/'],
  defaultOrigin: 'https://app.example.com',
  allowDataImages: false, // default true — set false to strip base64 data: images
  // blockedLinkClass / blockedImageClass — optional, default `blocked-link` / `blocked-image`
})
```

Semantics (enforced at the sanitizer sink, so it covers every rendered `<a>` —
including autolinks — and every `<img>` a host renders, on both sanitizer
backends and under Trusted Types):

- A link whose destination is **not** under an `allowedLinkPrefixes` entry is
  rewritten to `defaultOrigin` (or has its `href` dropped when `defaultOrigin`
  is empty) and tagged with `blockedLinkClass`. Allowed absolute links pass
  untouched.
- An image whose `src` is **not** under an `allowedImagePrefixes` entry is
  neutralized (its `src` is stripped so nothing loads; the element and its `alt`
  stay) and tagged with `blockedImageClass`.
- **Relative** URLs resolve against `defaultOrigin`; an allowed one is rewritten
  to its resolved absolute form. A relative URL with no `defaultOrigin` is
  blocked.
- **`data:` images** are governed solely by `allowDataImages` (default `true`),
  independent of the prefix list; `false` strips them.
- Pass `null` to remove the policy.

**Interaction with the scheme allowlist.** These are complementary, not
redundant: `setSafeHrefSchemes` is the scheme gate (it drops `javascript:`/`data:`
links *before* an `<a>` is built), and `setLinkImagePolicy` is the origin gate
over the schemes that survive. The origin policy does **not** re-check schemes —
keep scheme filtering in `setSafeHrefSchemes`.

**Bypass hardening.** Prefixes and each candidate URL are compared on their
WHATWG-canonical serialization (`new URL(...)` with credentials stripped), which
is the exact string the browser navigates to. That neutralizes the usual
allowlist tricks in one place: case-folded scheme/host (`HTTPS://Evil`),
`\` vs `/` (`https:\\evil`), embedded credentials (`https://good.com@evil.com`
resolves to `evil.com`, not a `good.com` prefix match), scheme-relative
`//evil.com`, leading/trailing whitespace, and unicode host confusables (folded
to punycode). No new runtime dependency is pulled in — the platform URL parser
does the canonicalization.

The classes it adds (`class` values) are already inside the sink allowlist, so no
`setSanitizeExtension` widening is needed for the policy itself. For images to
reach the policy at all, a host must first allow `<img>` through the sink (image
handling is host-injected — see [Raw images](#raw-images)).
## Entity decoding

CommonMark decodes the full HTML5 named + numeric character-reference set, but
the full named table is ~2,100 entries (~23 KB gzip — roughly half the core's
transfer size). Models overwhelmingly emit only the Latin-1 / typographic / math
tail of it, so the **default decoder is dependency-free**: it carries the 252
classic HTML4 named references plus *all* numeric references (which need no table
— they are algorithmic). Across the entire CommonMark spec that subset costs
exactly **one** example (#25, which packs HTML5-only names like `&Dcaron;` and
`&HilbertSpace;`).

Need the full HTML5 set? Register a decoder — no change to how you call the
renderer, decoding routes through it automatically:

```ts
import { setEntityDecoder, browserEntityDecoder } from '@copse/streaming-markdown'

// Option A — the browser's own parser table, via a detached <textarea>.
// Full HTML5 coverage at ZERO bundle cost. DOM only.
setEntityDecoder(browserEntityDecoder)

// Option B — the `entities` package (install it as a peer dep). Works anywhere,
// adds the ~23 KB table to your bundle. Best for Node/SSR without a DOM.
import { installFullEntityDecoder } from '@copse/streaming-markdown/entities/full'
installFullEntityDecoder()
```

Both are strict (a trailing `;` is required, per CommonMark) and decode any name
in the built-in set byte-identically to the full table.

Just need a handful of extra names? Extend the built-in set instead of shipping
the whole table:

```ts
import { addNamedEntities } from '@copse/streaming-markdown'

addNamedEntities({ checkmark: '✓', myco: '🌱' }) // keys are bare names, no &/;
```

`addNamedEntities` merges (user entries win on collision), `setNamedEntities`
replaces the user layer, `getNamedEntities` returns the effective set, and
`resetEntityDecoder` restores the default decoder and clears user names. These
affect the built-in decoder only — a `setEntityDecoder` decoder owns its own set.

## Widening the sanitizer allowlist

The sink allowlist in `sanitize.ts` mirrors exactly what the renderer emits and
is the security gate. If a host plug-in emits tags/attributes outside it (a custom
fence handler's scaffolding, a decorator's attribute, an artifact `<img>`), widen
the sink with `setSanitizeExtension` — and keep the additions as narrow as the
injected output. `onElement` runs for every kept element so a host can lock down
its own tags. Note the core gate strips any `id` outside the renderer's own
footnote shape (`fn-…`/`fnref-…`); a host that injects other ids must re-set
them from its `onElement` hook (which runs after the strip).

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
- **`styles/cjk.css`** — optional East-Asian line-break / spacing rules, gated on
  `:lang()` or a `.sm-cjk` class hook. Not imported by the other two; see the
  [CJK / East-Asian text](#cjk--east-asian-text) section above.

Retheme `default.css` by setting `--sm-*` custom properties on `.streaming-markdown`
(or any ancestor) — each has a fallback, so the sheet also stands alone. See the
header comment in [`styles/default.css`](../styles/default.css) for the full list
(`--sm-space-sm`, `--sm-border`, `--sm-accent`, `--sm-code-bg`, …).

The stylesheets are authored with native CSS nesting; bundle with a target that
supports it (any current engine) or let your bundler lower it.

### UI recipes

Widgets on top of the render — copy buttons on code blocks, download links,
carets — aren't part of the library; you add them in your own app (the same reason
the stylesheets are optional). [`RECIPES.md`](RECIPES.md) walks through building them
against the class hooks above, starting with **copy buttons** and the streaming
gotcha they hit: the incremental emitter *morphs* the DOM on every `update()`, so a
naïvely appended button gets reconciled away. It shows the correct
delegation + idempotent re-attach pattern and how to copy clean source rather than
tokenized markup.
