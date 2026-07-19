# Architecture & regression

Design and testing notes for `@copse/streaming-markdown`. For install/usage see
the [README](../README.md).

## Design invariants

When extending the renderer or its CSS, preserve these rules:

- **Sanitize at the sink.** `renderMarkdownUnsafe()` is a pure string→HTML function,
  but its output assembles HTML by concatenation and is treated as untrusted. Every
  `innerHTML` assignment of rendered markdown goes through
  `sanitizeRenderedMarkdown()` (`sanitize.ts`) first. The public `renderMarkdown()`
  (#104) bakes that sink in — it returns already-sanitized `SanitizedHtml` and
  throws when no backend is available — so it is the safe default; the streaming
  emitters likewise sanitize `renderMarkdownUnsafe()` output at their sinks. If you
  add a new sink or a new output tag/attribute, route it through the sanitizer and
  widen its allowlist to match. Mermaid SVG is produced after sanitization and is
  not re-sanitized. The rationale and the survey of streaming-parser alternatives
  are tracked in the consuming app's design docs.
- **Pluggable sanitizer backend.** `sanitize.ts` holds the narrow tag/attr allowlist
  and a single per-element gate (task-list `<input>` lockdown + host
  `SanitizeExtension.onElement`), but delegates the actual sanitize to a
  `SanitizerBackend` (the `sanitizerBackend` config field, applied around each
  render by `withConfig`). Two ship: the zero-dependency native
  Sanitizer API (`sanitize-browser.ts`, `Element.setHTML` + a strict allowlist walk;
  the default when available) and DOMPurify (`sanitize-dompurify.ts`, imported only
  via the `@copse/streaming-markdown/sanitizers/dompurify` entry so it stays out of
  bundles that use the native API). Both enforce the same allowlist and run the same
  gate, so security posture is backend-independent. When no backend is set and the
  native API is missing, `sanitizeRenderedMarkdown` throws rather than return
  unsanitized HTML. DOMPurify is an optional peer dependency; `dompurify` must not be
  imported outside `sanitize-dompurify.ts`, or it re-enters the default bundle.
- **Pluggable syntax highlighter.** `highlight.ts` holds only cheap string work
  (language aliases, `KNOWN_LANGUAGES`, `fenceCodeClass`) and a config-injected slot
  (the `codeHighlighter` field, applied by `withConfig`); it imports no highlight.js.
  The highlight.js grammars live in `highlight-hljs.ts`, imported only via the
  `@copse/streaming-markdown/highlighters/highlightjs` entry (`highlightjsHighlighter`,
  `loadHighlightjs` — the value, and the `load*` helper returning it to pass via
  config), so they stay out of bundles that don't opt in — the same split as the
  sanitizer backend. With no highlighter configured, `highlightFenceCode`
  returns escaped plain text; a later render with a `codeHighlighter` set upgrades fence
  interiors to token spans while `fenceCodeClass` keeps the element's class stable across
  the swap. `KNOWN_LANGUAGES` must stay in sync with the grammars the backend
  registers. `highlight.js` must not be imported outside `highlight-hljs.ts`, or it
  re-enters the default bundle. See [`LAZY-LOADING.md`](LAZY-LOADING.md).
- **Pluggable fence handlers (#53).** Which HTML a fenced code block emits is a map
  keyed by the fence's info-string language (`fence-handlers.ts`, the `fenceHandlers`
  config field, case-insensitive). A `FenceHandler` supplies the at-rest `render` plus an optional
  `forming` shape (string HTML + incremental DOM `sync`) used by both streaming emitters
  while the fence is still open; without one, forming falls back to `render` (string) and
  a sanitized-`innerHTML` replace (DOM). Fences are opaque to the block tokenizer, so a
  handler changes **emission only** — no parser surface. The built-in mermaid scaffolding
  is itself the reference handler, present by default (remove with
  `{ fenceHandlers: { mermaid: null } }`). Security posture is the mermaid two-phase shape:
  handler output is emitted **before** the sink sanitizer, so scaffolding must stay inside
  the sanitizer allowlist (or the handler's host widens it via `sanitizeExtension`);
  rich output is injected post-sanitization by a hydration step (`hydratePendingDiagrams`
  for mermaid, host-owned for others). Forming markup should carry
  `FORMING_FENCE_PRE_CLASS` on its root so promotion stays a class-only change (see the
  motion contract below).
- **Pluggable diagram renderer.** Mermaid is never bundled — the generator emits inert
  `mermaid-diagram--pending` scaffolding and `mermaid-source.ts` is pure string prep.
  `mermaid.ts` adds the async renderer seam (the `diagramRenderer` config field,
  consumed by `hydrate()` / `hydratePendingDiagrams`'s `renderer` option — not the
  synchronous render) plus `hydratePendingDiagrams`, which walks pending containers, tries the gentle then aggressive
  `mermaidSourceCandidates`, and injects the backend's SVG (or marks `--error`). The
  mermaid backend (`mermaid-mermaidjs.ts`, `mermaidDiagramRenderer` / `loadMermaid`) is
  imported only via the `@copse/streaming-markdown/diagrams/mermaid` entry, with `mermaid`
  an optional peer dependency. Mermaid SVG is injected after the sink sanitizer and not
  re-sanitized (see the sanitize-at-the-sink note); `hydratePendingDiagrams`'s `transformSvg`
  option is the seam for a host that wants to. `mermaid` must not be imported outside
  `mermaid-mermaidjs.ts`. See [`LAZY-LOADING.md`](LAZY-LOADING.md).
- **Pluggable math renderer (#70).** KaTeX is never bundled — the generator emits inert
  scaffolding for every math form: `math-block--pending` + `<pre class="math">` for
  ```` ```math ```` fences and `$$ … $$` / `\[ … \]` display blocks (own-line delimiters
  or a one-line `$$E=mc^2$$`; a tokenizer construct, `math_block`), and
  `math-inline--pending` spans for `$…$` / `$$…$$` / `\(…\)` inline math (a built-in
  pass in `inline-math.ts`, shielded through the inline-pass emit table). The **prose
  grammar is opt-in via `mathSyntax` (#78)**: `$…$`-style delimiters have
  realistic non-math readings (`set $PATH$ properly`), so the `math_block` construct,
  the inline pass, and their streaming holds activate only when the `mathSyntax` config
  field turns them on — preserving the invariant that output is byte-identical until a
  host opts in. `mathSyntax` (`true | false | null`) is a dependency-free leaf flag
  (`math-syntax.ts`) both the tokenizer and the inline pipeline read: `true` forces
  the grammar on, and `false`/`null` (the default) leave it off — a scaffolding-only
  host sets `{ mathSyntax: true }` and hydrates later with a renderer. The explicitly labeled ```` ```math ```` fence is never gated,
  like mermaid's. With the grammar on: single-dollar
  math carries remark-math's currency guards (no whitespace just inside the delimiters,
  no digit after the closing `$`), so `$20 and $30` stays prose; escaped `\$`, code
  spans/fences, and link destinations never delimit. Recognizing `\(…\)` / `\[…\]` — the
  OpenAI delimiter style — deliberately diverges from CommonMark's escaped-punctuation
  reading, gated to non-empty bodies so both conformance baselines are unchanged.
  `math.ts` holds the async renderer seam (the `mathRenderer` config field, consumed by
  `hydrate()` / `hydratePendingMath`'s `renderer` option — not the synchronous render)
  plus `hydratePendingMath`, which renders each pending element (display mode for blocks, inline for spans) and flips it
  to `--rendered` or `--error` (escaped source kept visible). The KaTeX backend
  (`math-katex.ts`, `katexMathRenderer` / `loadKatex`, `throwOnError:false` +
  `trust:false`) is imported only via the `@copse/streaming-markdown/math/katex` entry,
  with `katex` an optional peer dependency; the host loads the KaTeX stylesheet/fonts.
  KaTeX HTML is injected after the sink sanitizer and not re-sanitized (the mermaid
  trust boundary); `hydratePendingMath`'s `transformHtml` option is the seam for a host
  that wants to. `katex` must not be imported outside `math-katex.ts`. See
  [`LAZY-LOADING.md`](LAZY-LOADING.md).
- **Entity decoding is a pluggable, dependency-free default** (`entity-decoder.ts`, a
  leaf shared by `backslash-escapes.ts`, `link-references.ts`, and `block-patterns.ts`).
  CommonMark decodes the full HTML5 named + numeric reference set, but the full named
  table is ~2,100 entries (~23 KB gzip — ~half the core's transfer size), and models
  emit almost exclusively its Latin-1 / typographic / math tail. So the default decoder
  carries the 252 classic HTML4 named references (values pinned to their HTML5 code
  points, so any built-in name decodes byte-identically to the full table) plus all
  numeric references, which are algorithmic (Windows-1252 C1 remap + surrogate/range →
  U+FFFD, matching `entities`/`he`). Across the whole CommonMark spec that subset costs
  exactly one example (#25). The `entityDecoder` config field swaps in full coverage: `browserEntityDecoder`
  borrows the browser's own parser table through a detached `<textarea>` (zero bundle
  cost, strict because only complete `&name;` tokens are handed to it, so the parser's
  semicolon-less legacy decoding never fires), or the `@copse/streaming-markdown/entities/full`
  entry provides the `entities`-backed `fullEntityDecoder` (`entities` an optional peer
  dependency). The `namedEntities` config field extends the built-in set without a full decoder.
- **Package boundary.** The core stays app-independent so it can version and ship on
  its own, so host-specific behaviour is **injected, not hard-coded**:
  - `linkDecorator` (config field; `inline-links.ts`) — a `LinkDecorator` returns the
    attributes for a rendered `<a>`. The built-in default is **neutral** (#112): anchors
    carry only `href`/`title`, with no `target`, `rel`, `class`, or `data-*` routing hooks.
    The app's workspace/browser routing decorator (`appLinkDecorator`) lives behind the
    host-only `@copse/streaming-markdown/host/workspace` entry; a host restores the
    pre-0.10 in-app behaviour with `{ linkDecorator: appLinkDecorator }`.
  - `rawImageRenderer` (config field; `raw-images.ts`) — a `RawImageRenderer` decides what a raw
    `<img>` becomes (e.g. an app's artifact placeholder). The core escapes every
    `<img>` by default; the renderer's output bypasses escaping via a placeholder and
    is restored afterward.
  - `normalizeHostImagePath` (`raw-images.ts`) — determinism primitive for that renderer.
    Agent output references the same artifact through volatile `src` forms — a relative
    `artifacts/…` path, a container absolute path (`/opt/runner/artifacts/…`), a
    repo/directory-named path (`/home/user/<repo>/artifacts/…`), or a per-session download
    URL (`…/v1/agents/<id>/artifacts/download?path=artifacts/…`). Left verbatim in the
    rendered attribute, those volatile segments (container dir, repo name, directory layout,
    session id) change per run and churn the host's e2e **screenshots**. This collapses each
    to the same stable `artifacts/…` path (marker segment configurable; no host path is
    hardcoded) and keeps URL query params out of the path, so a host that renders
    `normalizeHostImagePath(src).path` gets identical output across machines. Hosts should
    route their artifact `<img>` through it and never fold volatile query params into a
    snapshot-visible attribute.
  - `sanitizeExtension` (config field; `sanitize.ts`) — widens the sanitizer allowlist and adds a
    per-element gate so a host's injected markup (e.g. its artifact `<img>`) survives
    sanitization. The core allowlist stays the security gate; keep additions narrow.

  A host emitting attributes outside the escape/sink allowlists must also widen
  `SAFE_OUTER_TAG_RE` (`escape.ts`) to match.
- **Valid block HTML.** Block elements (`<ul>`, `<ol>`, `<h3>`, `<h4>`, `<pre>`, `<table>`,
  `<hr>`) must never end up inside `<p>`. Mixed single-newline blocks (heading → subheading → list)
  are common in LLM output; split at block boundaries before wrapping paragraphs.
- **Pluggable inline passes (#53).** Custom inline syntax (citation `[@key]`, `==highlight==`,
  …) are supplied as ordered passes (`inline-passes.ts`, the `inlinePasses` config field) that run inside the
  inline pipeline at a declared stage: `before-links` (after strikethrough, before markdown
  link resolution — bracket syntaxes must consume their text before `[` is read as a label
  opener, as in Pandoc) or `after-links` (last, over rendered `<a>`/`<code>`). The registry —
  not each plugin — carries the hard parts: passes are applied only outside rendered
  `<code>`/`<a>`/`<img>` spans (the `INLINE_HTML_SHIELD_RE` split); generated HTML is spliced
  via `ctx.emit`, which parks it in a side table behind an inert PUA placeholder restored
  *after* `escapeHtmlTextNodes` (the raw-image placeholder pattern; attacker-typed placeholder
  characters are stripped before any pass runs); and a pass's optional `holdStart` composes
  into `pendingHoldIndex` so a half-open `[@doe` / `==foo` holds mid-stream instead of
  flashing raw. Emitted HTML still passes the sink sanitizer — the second gate — so passes
  using tags/attributes beyond the core allowlist must widen it via `sanitizeExtension`.
  Passes may run more than once over nested link-label text and must be idempotent
  (placeholder tokens make emitted output inert automatically).
- **Inline formatting order.** Fenced code → inline code → inline math (#70, when the
  math prose grammar is enabled (#78); before emphasis because math content is verbatim,
  like code — `$a_i * b$` must reach KaTeX untouched) → emphasis (delimiter stack) →
  GFM strikethrough → registered `before-links` inline passes → markdown links → bare HTTP
  autolinks → registered `after-links` passes. Emphasis runs before links so
  `*foo [bar](/url)*` resolves correctly; link labels may already contain `<em>` / `<strong>`
  from that pass. Strikethrough (`~~text~~` → `<del>`, `inline-strikethrough.ts`) sits between
  emphasis and links so `~~*x*~~` nests and a struck `~~[a](b)~~` still resolves its link inside
  the `<del>`; only paired **double** tildes delimit, so lone `~` (e.g. `20~25`) stays literal,
  and its streaming hold (`strikethroughHoldStart`) suppresses a half-open trailing `~~foo`.
- **Soft line breaks.** Prose paragraphs preserve single newlines in HTML (CommonMark soft breaks);
  hard breaks (two+ trailing spaces, or a backslash before the newline) emit `<br>` and swallow the
  next line's leading indentation. Breaks are marked before inline rendering (`markHardBreaks` in
  `render-prose-inline.ts`) so emphasis spans keep them; code-span interiors and raw `<tag>` spans
  are exempt. Tight list items still collapse internal newlines to spaces. `.message-text p` uses
  `white-space: pre-wrap` (the container is `normal`) so preserved newlines render as visible line
  breaks without `<br>` tags.
- **Agent-output shapes.** Support `-`, `*`, and `+` list markers. ATX `#` levels map to
  matching `<h1>`–`<h6>` tags; setext underlines (`===`/`---`) map to `<h1>`/`<h2>`
  (see `render-blocks.ts`). A GFM task-list marker (`[ ]`/`[x]`/`[X]` followed by a space) at
  the start of an item's first line renders a read-only `<input type="checkbox" disabled>`
  (`parseTaskListMarker`/`renderListItem` in `render-blocks.ts`); the item gets
  `class="task-list-item"` and its list `class="contains-task-list"` for bullet-free styling
  ([#614](https://github.com/copse-dev/agent-pane/issues/614)). `input` + `type`/`checked`/`disabled` are on the sanitizer allowlist, and the
  per-element gate drops any non-checkbox `<input>` (see `sanitize.ts`).
- **GFM footnotes (#72).** Inline `[^label]` references render as
  `<sup class="footnote-ref"><a href="#fn-<slug>" id="fnref-<slug>">N</a></sup>`,
  numbered in first-use order; repeated references share N with distinct
  `fnref-…-2` ids (GitHub's shape). `[^label]: content` definition blocks are
  collected like link reference definitions (`footnote_def` in
  `block-tokenizer.ts`, `collectFootnoteDefinitions`; they never render in
  place) and the referenced ones render as a trailing
  `<section class="footnotes"><ol>…</ol></section>` in reference order, each
  item ending with a `<a class="footnote-backref">↩</a>` to its first
  reference. Unresolved references stay literal (mirroring unresolved link
  refs); unreferenced definitions are dropped (GitHub behavior). Definitions
  support indented continuation lines and multi-paragraph content via blank +
  4-space indent, plus lazy first-paragraph continuation; footnotes inside
  blockquotes are out of scope. Slugs are deterministic (`footnotes.ts`),
  attribute-safe, and collision-disambiguated; the sanitizer allowlists
  `section`/`h2` + `id` and its element gate strips any id outside the
  `fn-…`/`fnref-…`/`…footnote-label` shape. The section carries GitHub's a11y
  hooks — `data-footnotes`, a visually-hidden `<h2 id="…footnote-label"
  class="sr-only">Footnotes</h2>`, `data-footnote-ref` + `aria-describedby` on
  each ref, and `data-footnote-backref` + `aria-label="Back to reference N"` on
  each backref (allowlisted in `sanitize.ts`). Because smd's primary use is a
  chat UI stacking many rendered messages on one page, every footnote id and its
  anchor can be namespaced with a per-render `footnoteIdPrefix`
  (`MarkdownConfig`, default `''` → byte-identical to prior output): with a
  distinct prefix per message, `fn-<prefix><slug>` / `fnref-<prefix><slug>` /
  `<prefix>footnote-label` never collide across messages. The prefix must be
  host-supplied, deterministic, and stable across incremental updates (no
  `Math.random()`/`Date.now()`), captured once on the `FootnoteContext`. The
  reference state is a per-render `FootnoteContext` installed by
  `renderMarkdown`, so both streaming emitters (which render through it)
  converge. Streaming: a half-typed `[^lab` holds
  via `footnoteHoldStart` (composed into `pendingHoldIndex` like the
  strikethrough hold), pending definition lines hold entirely
  (`isPendingFootnoteDefLine`), and the trailing section re-renders as
  definitions commit — footnote-bearing documents take the frozen-tail
  full-morph path because a late definition upgrades earlier literal `[^x]`
  text (see `streaming-frozen-tail.ts`).
- **GitHub alerts (#72).** A blockquote whose first line is exactly `> [!NOTE]`
  (or TIP / IMPORTANT / WARNING / CAUTION, case-insensitive, nothing else on the
  marker line) renders with GitHub-compatible classes:
  `<blockquote class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p>…</blockquote>`
  (`alerts.ts` + `renderBlockquote` in `render-blocks.ts`). Unknown `[!FOO]`
  markers fall through to a plain blockquote with the marker line literal
  (GitHub behavior); nested list/blockquote recursion classifies alerts inside
  containers the same way. While streaming, a complete marker line classifies
  the *pending* quote too (same classes + title `<p>` on
  `blockquote.stream-pending-blockquote`), and a half-typed `[!NOT` holds, so a
  literal marker never flashes and promotion is class-only. The
  `markdown-alert*` classes pass the sink sanitizer (`class` is allowlisted);
  `default.css` themes the five types via `--sm-alert-*` custom properties.
- **Raw-HTML policy (`htmlPolicy`, #600).** The default is **passthrough**: the
  renderer emits any well-formed raw HTML tag verbatim and defers entirely to the
  sink sanitizer (`sanitize.ts`) as the sole arbiter — allowlisted tags render as
  real elements, everything else is stripped/unwrapped, `<script>` and event
  handlers are removed. The keep/escape decision lives in `escapeHtmlOutsideSafeTags`
  (`escape.ts`, gated on `getHtmlPolicy()`); a lone `<`, a `<` that never forms a
  tag (`a < b`, `<3`), and an unterminated `<div` stay literal under either policy.
  The opt-out `htmlPolicy: 'escape'` (the config field on `renderMarkdown` / the
  streaming entry points) reproduces the historical behavior
  byte-for-byte: every tag outside the benign attribute-less inline allowlist
  (`<b> <i> <u> <s> <del> <ins> <sub> <sup> <kbd> <mark> <br>`,
  `BENIGN_RAW_INLINE_TAG_RE`) is escaped into literal prose. Block-level raw HTML
  is not a distinct token — it tokenizes as a prose paragraph and follows the same
  path (as does indented raw HTML, reclassified by `isIndentedHtmlBlock`). See
  [docs/decisions/0002-raw-html-passthrough-default.md](decisions/0002-raw-html-passthrough-default.md).
  The sanitizer allowlist is **not** widened by this policy.
- **Indented code blocks (#9).** 4-column-indented lines **are** rendered as CommonMark
  indented code (`<pre><code>`), and this construct **conforms** — `summaryBySection` in the
  conformance baseline records **Indented code blocks: 12/12**. Recognition happens in the block
  tokenizer (`indented_code` in `block-tokenizer.ts`); emission is `renderIndentedCode`
  (`render-blocks.ts`), which strips the opening 4-column indent (`stripFourColumnIndent`,
  `block-patterns.ts`) and keeps content verbatim. This is deliberately **on by default**: LLM
  output favours fenced code, but as a general-purpose CommonMark library, silently dropping
  indented code would surprise consumers — so it stays supported. `renderMarkdown` exposes an
  opt-out `{ indentedCode: false }` (`RenderMarkdownOptions`, `renderer.ts`) for hosts that want
  the divergence: with it, a top-level `indented_code` block renders as a prose paragraph instead
  of `<pre><code>`. The option is threaded through `RenderBlocksOptions.indentedCode`
  (default `true`) and applies at the **top level** only — recursive list/blockquote content keeps
  CommonMark indented-code semantics, and the default path (and the conformance baseline) is
  unchanged.

  **Tab expansion.** Leading tabs expand to a 4-column stop for indented code, tab as
  the ATX-heading separator, and tab-indented continuation lines (see the `renderMarkdown tab
  handling` suite in `renderer.test.ts`). The spec's `Tabs` section now **fully conforms** — the
  baseline records **Tabs: 11/11**. This is tracked by the conformance baseline rather than a
  separate list, so any regression shows up as the `Tabs` count dropping on re-baseline
  (`UPDATE_COMMONMARK_BASELINE=1 npm test`).

- **Indented HTML blocks.** CommonMark makes any 4-space-indented line an indented code block,
  so a model that indents a `<div>`/`<table>` snippet would otherwise get a literal `<pre><code>`
  dump. At the **top level** (`renderMarkdown` sets `htmlFromIndent`), an `indented_code` block
  whose first dedented line opens with a block-level HTML tag (`isIndentedHtmlBlock`,
  `indented-html.ts`) is reclassified as prose so it follows the raw-HTML policy above — the same
  output as its un-indented form. Gated to the top level on purpose: list/blockquote content is
  tokenized recursively, so nested indented code keeps CommonMark semantics. Genuine indented code
  that merely opens with an inline tag (spec #110, `    <a/>` then `*hi*`) is unaffected because
  `a` is not in the block-tag list ([#616](https://github.com/copse-dev/agent-pane/issues/616)). Example — this indented block renders as escaped
  `&lt;div&gt;…` prose, not a code block:

  ```text
      <div>
      <p>hi</p>
      </div>
  ```

- **Streaming hold.** Incomplete block starts (fences, thematic breaks, blockquotes) stream as
  plain text in the inline pending tail until their line ends. Open fenced code blocks
  forward-pass into `.stream-forming` as `<pre class="stream-fence-forming">` with highlight.js on
  the body so far (mermaid fences show a pending source placeholder until complete).
  Forming GFM tables forward-pass into `.stream-forming` (`<table class="stream-table-forming">`) as header/separator/body
  cells arrive; committed tables append body rows via `tr.stream-pending-row` with
  inline cell updates. Pending **list** lines hide the `-`/`*`/`1.` marker and show
  body text with a bullet/number via `.stream-pending-list-item` until the line
  ends and the full `<ul>/<li>` (or `<ol>/<li>`) is committed. Pending **ATX
  headings** (`#` … `######`) hide the hash run and render title text in a
  `<div class="stream-pending-heading stream-pending-hN">` (`data-heading-level`) with
  matching heading weight/size until the line completes. **HTML entities** in prose
  (`&nbsp;`, `&#160;`) decode via `decodeSafeMarkdownEntities()` (with incomplete suffixes
  held so `&nbsp` never flashes literally); other entities stay escaped for XSS safety.
  Inline hold still suppresses half-open `**` on the current line. **Forming links** reveal
  their label early: `revealFormingLink` (`render-pending-line.ts`) turns a still-open
  `[label` / `[label](https://partial` into just its label text — so no literal brackets flash
  and the partial URL is never rendered or autolinked — then the completed `[label](url)` upgrades
  to a real `<a>` on commit ([#617](https://github.com/copse-dev/agent-pane/issues/617)). Only the trailing forming link is touched; earlier complete
  links, `[ref]` shortcuts, and `[` inside code spans or after a backslash are left alone.
  **Forming inline code** follows the same progressive-preview rule: an unmatched backtick
  run keeps its delimiter hidden but reveals its escaped, markdown-opaque contents inside
  `<code class="stream-forming-inline-code">`. A matching run promotes it to ordinary
  `<code>`; if the line settles unmatched, the at-rest CommonMark render wins and restores
  the literal backticks. This bounds a malformed opener's mid-line stall without guessing
  a non-standard closing rule.

  **End of stream is host state.** Neither streaming emitter can distinguish "the last
  token arrived" from "more text may still arrive" by inspecting a growing string. A host
  that knows the stream closed must supply a final commit boundary (the demo's `sealDoc`
  appends a newline) or switch to `renderMarkdown` for the at-rest frame. The demo fidelity
  check seals both streaming paths and compares each with a fresh at-rest render; agreement
  between the two streaming paths alone is not a convergence proof.

  Pending shapes (`streaming-pending-matrix.test.ts`):

  | While streaming         | DOM / class                                                      | Raw marker hidden?      | Inline MD in tail? |
  | ----------------------- | ---------------------------------------------------------------- | ----------------------- | ------------------ |
  | Prose paragraph         | `<p class="stream-pending-paragraph">`                           | n/a                     | yes                |
  | Lazy ¶ continuation     | `\n` + `<span class="stream-pending-paragraph-continuation">` inside the open `<p>` | n/a | yes                |
  | Half-open inline code   | `<code class="stream-forming-inline-code">` in a same-line pending continuation | yes | no (escaped/opaque) |
  | `- item` / `1. item`    | `<ul>/<ol>` with native `<li class="stream-pending-list-item">`  | yes                     | yes                |
  | Nested `  - item`       | nested `<ul>/<ol>` inside open `<li>`                            | yes                     | yes                |
  | Lazy list continuation  | `<span class="stream-pending-list-continuation">` in open `<li>` | n/a (plain text)        | yes                |
  | `### Heading`           | `<div class="stream-pending-heading stream-pending-hN">`         | yes                     | yes                |
  | `> quote`               | `<blockquote class="stream-pending-blockquote"><p>…</p>`         | yes                     | yes                |
  | `> [!NOTE]` marker line | `<blockquote class="stream-pending-blockquote markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p>` | yes (half markers hold) | n/a |
  | `---`                   | `<span class="stream-pending">` escaped plain text               | no                      | no                 |
  | Forming `\| H \|` table | `.stream-forming` + `<th>`                                       | pipes = cell boundaries | per cell           |
  | Pending table body row  | `tr.stream-pending-row` + `<td>`                                 | pipes = cell boundaries | per cell           |
  | Open fenced code        | `.stream-forming pre.stream-fence-forming`                       | yes                     | highlighted        |
  | Open `$$` / `\[` math   | `.stream-forming .math-block--pending.stream-fence-forming`      | yes                     | no (verbatim TeX)  |
  | Half-open `$x+` inline  | held via `pendingHoldIndex` (nothing shown past the `$`)         | yes                     | n/a                |
  | Forming `<div class="`  | held via `pendingHoldIndex` (`rawHtmlTagHoldStart`); reveals as a real element on `>` | yes (passthrough) | n/a       |

  These class hooks are exercised by the optional reference stylesheets in
  [`styles/`](../styles) — `core.css` (structural rules the output needs to render
  correctly: pending-state whitespace, task-list markers, code whitespace, blowout
  guards) and `default.css` (a themed look on top, `--sm-*`-overridable). Both scope
  every rule under a `.streaming-markdown` class; the host adds that class to the
  render sink. The stylesheets are the visible companion to this table — renaming a
  class here means updating them.

### Pending→committed motion contract (#11)

The emitter guarantees each pending→committed transition is a **minimal DOM patch**
(no full-subtree replacement — asserted by `streaming-minimal-patch.test.ts`), so a
theme can make promotion visually smooth. The promoting node itself changes tag or
class, which is why the styling rule is: **pending chrome must never move text** —
a pending block carries the exact metrics (font size/weight, line-height, margins,
text x-position) of the element it commits to, and promotion changes *color only*.
Per jank scenario:

| Scenario                        | Strategy                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Heading promotion (`div` → `hN`)| Metric parity in CSS: `.stream-pending-hN` carries the committed `hN` font-size, weight, and margins (`default.css` does this); only color/background change.        |
| Paragraph commit (`p` → `p`)    | Same tag either side. Accent chrome must not indent text — hang a bar in the gutter with a negative margin that cancels its border+padding, or use background only.  |
| Long-paragraph soft breaks      | A later line of an open paragraph is a *lazy continuation* (the tokenizer kept it in the paragraph because it can't interrupt one), so it renders as `\n` + `span.stream-pending-paragraph-continuation` **inside** the trailing committed `<p>` — never as a separate block that would visibly merge upward on commit. The soft-break `\n` sits outside the span, as paragraph text, so it displays exactly as the committed soft break will under the host's `white-space`. |
| List marker reveal              | Pending items are real `<li>` in a real `<ul>/<ol>` from the first frame, so the marker column is already reserved; style with background/marker color only.         |
| Table row commit                | Rows stream as real `<tr class="stream-pending-row">` cells; commit removes the class in place — color-only.                                                         |
| Fence close + hljs              | The forming fence is a real `<pre><code>` with highlight.js already applied, so closing only swaps `stream-fence-forming` off. Don't re-declare font metrics on the forming class (they'd compound with `pre code` rules). Highlight classes appearing is color-only — **instant is OK**. |
| Table column re-measure         | **Instant is OK** — `table-layout: auto` re-negotiates column widths as cell text streams. Pinning it (`fixed`) would change how committed tables render arbitrary content, a worse trade. |
| Subtle motion                   | Because committed nodes keep identity, a theme can animate *new* nodes only: `default.css` ships an opacity-only, `prefers-reduced-motion`-guarded settle fade scoped to `.stream-complete` (never the string emitter, which recreates all nodes per token). |

  `docs/index.html` (the live demo) implements the same contract with its own
  theme and doubles as the visual regression bed for it.

### Streaming architecture (intentional duplication)

The streaming layer maintains **two parallel emitters** for the same decisions:

| Path            | Used by                     | Updates                   |
| --------------- | --------------------------- | ------------------------- |
| String HTML     | `renderStreamingMarkdown`   | full re-render each token |
| Incremental DOM | `StreamingMarkdownRenderer` | forward-pass patches      |

Shared helpers (`renderStreamingTableCell`, `insertBeforeTrailingListClose`,
`splitOpenBlockAtLastNewline`, `clearBlockPendingDom`, `blockPendingClassName`, …) hold
**decision logic** in one place. Emitters stay separate on purpose — merging HTML builders
with DOM sync (e.g. always setting `innerHTML` from a string) breaks incremental updates and
is brittle under `streaming-convergence.test.ts`.

**Not yet unified** (higher risk; defer unless adding a new pending shape):

- Forming-table line parser shared by `buildFormingTableHtml` / `syncFormingTableDom` (separator
  row HTML vs DOM intentionally differ).
- List pending: `appendListPendingHtml` vs `syncListPendingDom`.
- Block pending metadata: `blockPendingAttrs` (HTML) vs `setAttribute` in DOM sync.
- `classifyPendingBlock()` — single classifier for `isBlockLevelPending` / `blockPendingTag` /
  `blockPendingClassName`.
- Orchestration object shared by `renderStreamingMarkdown` and `StreamingMarkdownRenderer.update`.
- `render-pending-line.ts` hold→visible→render branches (readability only).

- **Inline emphasis.** A single delimiter-stack path (`inline-emphasis.ts`) handles all emphasis;
  there is no separate regex fast path.
- **List indent.** Global `* { padding: 0 }` strips UA list padding. Restore readable indent on
  `.message-text ul/ol` in `global.css` (currently `padding-inline-start: 1.5em;
list-style-position: outside`). Bullets should sit clearly inset from headings, not flush with
  them.
- **Subagent explore cards.** Render markdown in the timeline via `renderMarkdown` (see
  `conversation.ts`). The collapsed summary preview also renders markdown, but is hidden when the
  card is expanded — the timeline is the single source of truth; never show truncated raw `## …`
  text.
- **Fixtures over toy examples.** E2e seeds should mirror real agent summaries (multi-section
  headings + lists, explore subagent with `` `snake_case` `` tool names), not single-line `- foo`.
- **Fenced code.** Non-mermaid fences are highlighted at render time via `highlight.js` (core +
  per-language imports in `highlight.ts`). Unknown tags fall back to escaped plain text; empty
  lang uses auto-detection. Theme tokens live in `global.css` (VS Code Dark+ inspired). Content is
  kept **verbatim** — interior/leading/trailing blank lines and the first line's indentation
  survive (`highlightFenceCode` no longer trims; blank-only fences are preserved), and only the
  opening fence's own indentation is stripped from content lines (`parseFenceSlice`). The language
  is the first word of the info string with backslash escapes / entities decoded
  (`fenceInfoLanguage`, spec #24: ` `foo\+bar ```→`language-foo+bar`) ([#598](https://github.com/copse-dev/agent-pane/issues/598)).
- **Mermaid diagrams.** Fenced ` ```mermaid ` blocks render as SVG via lazy-loaded `mermaid`
  (`mermaid.ts`). Diagram rendering runs after final markdown insertion (`message_done`, thread
  restore) — not on every streaming token. Fenced blocks are extracted before HTML escaping; prose
  markdown (bold, lists, headings) must not run inside diagram `<pre>` tags (`mapOutsideFencedHtml`).
  Before render, `prepareMermaidSource` / `mermaidSourceCandidates` decode entities and quote brittle
  `[labels]`. We call `mermaid.run` directly (no pre-parse gate — parse rejects some diagrams that
  still render). On failure after an aggressive retry, show the inline source fallback.
- **Table layout.** Agent tables are unschema'd GFM — do not hardcode rem/% column widths for
  specific fixtures. Use shrink-to-fit edge columns (`width: 1%` + `nowrap`), `min-width: 0` on
  cells, and wrapping lone `<code>` slugs. Full rules live in the consuming app's UI docs.

Prefer structural unit tests on HTML output over pixel-diff screenshots. The DOM-level and
end-to-end specs referenced below (`tests/e2e/*.e2e.ts`, WebdriverIO; CSS class assertions) live
in the **consuming app** — this package ships the renderer and its unit/conformance suite; the
host owns the browser-rendering and layout checks.

## Regression

CI runs `npm run typecheck` + `npm run check:gfm-spec` + `npm run coverage:ci` + `npm run build` +
`npm run check:normalizer-parity`. `coverage:ci` runs the unit suite (plus the CommonMark **and** GFM
conformance baselines) under c8 and enforces the coverage-baseline ratchet. The DOM-glue and layout
specs listed below are maintained by the downstream host app.

### Unit tests (`renderer.test.ts`, via `npm test`)

- No `<ul>` nested inside `<p>` for multi-section agent summaries
- `*italic*` and `` `snake_case` `` code spans stay intact (no cross-line `<em>` bleed)
- Explore-style fixtures: `##`/`###` headings, `<hr>`, and lists as sibling block elements

### CommonMark conformance (`commonmark-conformance.test.ts`, via `npm test`)

`renderMarkdownUnsafe` (the raw parser output, before any sink) is run against
every example in the official CommonMark spec —
loaded from the pinned `commonmark-spec` devDependency at runtime
(`tests/commonmark/load-spec.ts`), so the ~650 examples are **not** vendored into
this repo — comparing output to the expected HTML after the spec's own normalizer
(`tests/commonmark/normalize.ts`, a faithful port of `normalize.py`). This is **at
rest only** — streaming output intentionally differs (the live tail holds/reveals
forming constructs) and is not conformance-tested. The harness is also pinned to
`htmlPolicy: 'escape'` (see the raw-HTML policy note below).

The renderer is app-specific in places (decorated links, highlighted code), but
CommonMark is the structural reference. The set of examples we currently satisfy
is pinned in `tests/fixtures/commonmark/conformance-baseline.json`
and the test fails if it changes:

- fewer passing → a regression in a construct we used to handle.
- more passing → an improvement; re-run `UPDATE_COMMONMARK_BASELINE=1 npm test` to
  record the new baseline.

Bumping the spec is just `npm i -D commonmark-spec@<version>` followed by a
re-baseline; the version is read from the installed package and pinned in the
baseline.

#### Raw-HTML policy and the in-scope conformance ceiling ([#600](https://github.com/copse-dev/agent-pane/issues/600))

**100% CommonMark is deliberately not the goal — and the conformance harnesses
are pinned to `htmlPolicy: 'escape'`, not the runtime default.** The default is
now passthrough (raw HTML deferred to the sink sanitizer), but the harnesses run
in `'escape'` mode so the pinned baselines measure the historical raw-HTML
behavior and do not churn. Under `'escape'`, two spec sections are expected to
fail by design:

| Section     | Baseline | Why it caps out                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------ |
| HTML blocks | 2/44     | Full conformance needs `<script>`/`<style>`/`<div>`/arbitrary custom tags verbatim.  |
| Raw HTML    | 8/20     | Same — no inline allowlist ever reaches 20/20 without passing attacker HTML through. |

Under `'escape'`, the only raw HTML that passes through is the **benign
attribute-less inline allowlist** (`b i u s del ins sub sup kbd mark br`,
`BENIGN_RAW_INLINE_TAG_RE` in `escape.ts`), mirrored by the sanitizer sink.
Everything with attributes, and all block/structural raw HTML, stays escaped.

So the realistic ceiling excludes those **64 HTML examples**: **588 in-scope
examples**, of which the renderer currently satisfies **569/588 (~97%)**. Counting all
652 examples the baseline is **579/652 (~89%)**. Both numbers move as non-HTML
conformance grows — `summaryBySection` in the baseline JSON carries the live
per-section counts; treat the two headline figures here as approximate. The full
live table (both specs × both policies, headline + in-scope ceiling + per-section
breakdown) is generated from the four baseline JSONs by
`npm run report:conformance` (`scripts/conformance-report.mts`) — regenerate it
rather than hand-editing these numbers.

**Deliberate autolink-scheme divergence (#139).** Angle autolinks (`<scheme:…>`)
route through the same scheme allowlist as markdown links (`safeLinkHref` /
the `safeHrefSchemes` config field) rather than a `javascript:`/`data:`/`vbscript:` deny-list,
so an unlisted scheme fails **closed** (stays literal) instead of rendering a
live `<a href>`. This is the security posture — a deny-list is the only fail-open
link path — at the cost of **4 CommonMark autolink examples** (`<irc://…>`,
`<a+b+c:d>`, `<made-up-scheme://…>`, `<localhost:5001/…>`) that the spec links but
carry non-allowlisted schemes. `http(s)`/`mailto`/`ftp(s)`/`tel`/`sms` autolinks
are unaffected; a host widens the set with the `safeHrefSchemes` config field.

**Passthrough is now the runtime default** (`htmlPolicy: 'passthrough'`,
`html-policy.ts`): the renderer emits well-formed raw HTML and the sink sanitizer
is the sole arbiter (allowlisted → element; otherwise stripped/unwrapped). The
security posture is unchanged — the sink allowlist is the boundary and stays
narrow — but the renderer no longer does a *second, redundant* escape. The
`'escape'` opt-out is retained for a host that consumes the renderer string
without a sink. **The true passthrough spec ceiling is now measured** (#141):
each harness pins a *second* baseline under the shipping `passthrough` default
(`conformance-baseline-passthrough.json`, `gfm-conformance-baseline-passthrough.json`),
regenerated with `UPDATE_COMMONMARK_PASSTHROUGH_BASELINE=1` /
`UPDATE_GFM_PASSTHROUGH_BASELINE=1`. Passthrough passes a few more of the spec
examples than escape — CommonMark **583**/652 vs **579**/652, GFM **593**/672 vs **589**/672 — raw HTML
flows to the sink instead of being escaped, so several Raw-HTML / HTML-block examples
now match the spec verbatim while **5** escape-mode-only shapes (inline raw-HTML
examples #619–624 in CommonMark, #638–643 in GFM, whose escaped output happens to
match the spec) drop, for a net **+4** in each spec. (`npm run report:conformance`
prints the exact gained/dropped set delta.) The escape baseline
stays the canonical passing-example corpus the streaming/bench suites reuse. HTML
**block recognition** in `block-tokenizer.ts` is still not a distinct token —
block HTML tokenizes as prose and follows the inline policy. An element that pairs
across blank-line block boundaries (`<details>`, a hand-typed `<div>`) can't be
frozen per-block without closing it early, so the frozen-tail freeze guard
(`hasUnbalancedRawHtml`) full-morphs while it is open, and a still-forming
`<details>` holds the streaming tail (`hasOpenDetailsElement`) so its collapsed
body is not flashed — see the decision note's freeze-guard discussion.

### GFM conformance (`gfm-conformance.test.ts`, via `npm test`)

GFM is a strict superset of CommonMark, adding tables, task lists, strikethrough,
extended autolinks (`www.`/bare-URL/email), and a disallowed-raw-HTML filter. The
renderer implements those extensions (GFM mode is always on — there is no
CommonMark-only switch), so a **second conformance harness** measures the official
[GFM spec](https://github.github.com/gfm/) the same way `commonmark-conformance.test.ts`
measures CommonMark: every spec example runs through `renderMarkdownUnsafe`, is compared
after the shared normalizer, and the passing set is pinned in
`tests/fixtures/gfm/gfm-conformance-baseline.json` (fail on drift either way;
re-baseline with `UPDATE_GFM_BASELINE=1 npm test`). The baseline JSON also carries an
`extensionSummary` block isolating the five GFM-only sections.

Unlike CommonMark — which ships as the `commonmark-spec` devDependency — the GFM
spec is **not published to npm**. Rather than vendor its ~10k-line `spec.txt`, it is
**fetched on demand** into `tests/fixtures/gfm/spec.txt` (gitignored) from
`github/cmark-gfm` tag `0.29.0.gfm.13`. Its provenance is pinned by SHA-256 in
`tests/gfm/load-spec.ts` and enforced by `scripts/fetch-gfm-spec.mts`
(`npm run check:gfm-spec`, a CI step that runs before the suite) — the same
fetch-and-verify pattern used for the reference normalizer. A bare offline
`npm test` without the fetched spec skips the GFM suite cleanly. Both specs
share one example parser (`parseSpecExamples` in `tests/commonmark/load-spec.ts`);
GFM tags its extension examples with a category word on the fence (`example table`),
which the parser tolerates. To bump the spec: edit `GFM_SPEC_SOURCE` in
`tests/gfm/load-spec.ts`, run `npm run check:gfm-spec -- --refresh`, update the
recorded SHA-256, then re-baseline.

**Extension coverage is partial by design** (`extensionSummary` carries the live
counts). Current state:

| GFM extension section   | Baseline | Notes                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------- |
| Strikethrough           | 2/2      | Full — double-tilde `~~x~~` → `<del>`.                                                     |
| Tables                  | 8/8      | Full — column alignment (`:-:`/`--:` → `align`, `parseTableAlignments`), escaped `\|` in cells (`splitTableRow`), column-count normalization and delimiter/header mismatch rejection (`tableColumnsMatch`) are all implemented. |
| Task list items         | 0/2      | Renderer output diverges on purpose — it adds `class="task-list-item"`/`contains-task-list` and a `disabled` checkbox for app styling ([#614](https://github.com/copse-dev/agent-pane/issues/614)), which the spec's bare `<input>` output does not.  |
| Autolinks (extension)   | 11/11    | Full (#125) — bare `http(s)://` plus `www.`, bare-URL, and email autolinks (`inline-autolinks.ts` / `inline-spans.ts`). Trailing-punctuation trimming follows GFM's balanced-paren rule (a closing `)` that balances an earlier `(` stays in the link, #107) and the extension's boundary/entity rules. |
| Disallowed Raw HTML     | 0/1      | In the harness's pinned `'escape'` mode the renderer escapes *all* attributed/structural raw HTML, which is stricter than GFM's tag filter — so the filtered-passthrough output never matches. |

Tables, Strikethrough, and Autolinks are the fully-conforming extensions. The
remaining two cap out on **deliberate divergences, not gaps to close**: task-list
items add `class="task-list-item"`/`contains-task-list` and a `disabled` checkbox
for app styling, and Disallowed Raw HTML is escaped more strictly than GFM's tag
filter under the harness's pinned `'escape'` mode.

### Streaming convergence fuzz (`streaming-convergence.test.ts`, via `npm test`)

Reuses the same CommonMark baseline examples (`tests/commonmark/baseline-examples.ts`)
as property-test inputs: for each passing spec example, every prefix cut (or a
strided sample when the markdown is long) feeds `StreamingMarkdownRenderer`
incrementally, then the full text, and the final display must match a fresh
complete render. When the tokenizer commits the entire input (no pending tail),
that display must also match the at-rest `renderMarkdown()` output. Set
`STREAMING_FUZZ_ALL=1` to exercise every character index on long examples.

### Performance benchmark (`scripts/bench-streaming.mts`, via `npm run bench`)

Complements the correctness fuzz with a wall-clock benchmark ([#618](https://github.com/copse-dev/agent-pane/issues/618)). It replays
three fixtures token-by-token — a mix of medium CommonMark baseline examples, the
`terms-of-service-streaming.md` agent output, and a synthetic wide-table + long-list
worst case — through **both** streaming emitters and reports the median time to stream
each to completion:

```
npm run bench              # defaults: iters=5 warmup=2 chunk=8
npm run bench -- --iters 9 --chunk 4
```

| Column      | Meaning                                                           |
| ----------- | ----------------------------------------------------------------- |
| `string ms` | `renderStreamingMarkdown` — full re-render + sanitize each update |
| `dom ms`    | `StreamingMarkdownRenderer.update` — incremental DOM patches      |
| `dom/str`   | ratio of the two (lower = the incremental path is winning)        |

Each fixture is capped at ~160 replay steps (the chunk size scales up with input) so
the O(n²) string path can't blow up the run. Absolute numbers are machine-dependent —
treat them as a **relative baseline**: the incremental DOM path pulls ahead on larger,
structure-heavy inputs (`dom/str` well under 1), while on small docs the two are
comparable (~1×) because the DOM-patch bookkeeping costs about as much as a cheap
re-render. A regression is a large jump in either column — or the ratio climbing
noticeably — for a modest input change: that is the super-linear behaviour the harness
exists to catch. Run it before/after a streaming change and compare.

### Terms of Service fixture (`streaming-terms-of-service.test.ts`)

Real-world agent output in `tests/fixtures/terms-of-service-streaming.md` — nbsp metadata,
numbered clauses, subscription fee table, blockquotes, and a fenced address block. Tests
scan incremental streaming cuts for partial-table artifacts (raw `| cell |` text in inline
`.stream-pending` or prose blocks while a table is already committed). Use this fixture when
changing table/list/metadata streaming behaviour.

The JS normalizer (`tests/commonmark/normalize.ts`) is differentially validated
against the reference `normalize.py` by `npm run check:normalizer-parity` (a CI
step in the `build` job; needs python3). The reference normalizer is **not**
checked in — `scripts/fetch-reference-normalizer.mts` fetches it from a pinned,
SHA-256-verified upstream commit into `tests/commonmark/normalize.py`
(gitignored) at check time. The parity check then asserts both that the
conformance pass set is identical under either normalizer and that per-example
normalized output matches byte-for-byte, except for a small documented allowlist
of pathological raw-HTML cases. This is **not** part of `npm test`, so
contributors without python can still run the default gates.

### E2e tests (seeded via `tests/e2e/helpers/seed-config.ts`)

- `tests/e2e/markdown-list-indent.e2e.ts` — Known Failures + Architecture Highlights; asserts list
  text is inset >4px from headings
- `tests/e2e/markdown-streaming-list.e2e.ts` — lazy list continuations stream inside the open
  `<li>` without a fake bullet row
- `tests/e2e/markdown-streaming-heading.e2e.ts` — pending `###` titles render in
  `.stream-pending-heading` without raw `#` markers
- `tests/e2e/markdown-streaming-blockquote.e2e.ts` — pending `>` lines render in
  `<blockquote class="stream-pending-blockquote">` without raw `>` markers
- `tests/e2e/markdown-nbsp-metadata.e2e.ts` — sprint/RFC metadata lines decode `&nbsp;` while
  streaming
- `tests/e2e/semantic-search-markdown.e2e.ts` — explore subagent timeline; asserts no raw `##` in
  rendered text, summary preview hidden when expanded, code spans intact
- `tests/e2e/mermaid-diagram.e2e.ts` — seeded flowchart; asserts `.mermaid-diagram svg` renders
- `tests/e2e/markdown-table-wrap.e2e.ts` — PR-style table; index/status stay single-line, branch
  slugs wrap, table fits pane (see `docs/ui-taste.md`)

Screenshots under `tests/e2e/screenshots/` (`markdown-list-indent-*.png`, `semantic-search-*.png`)
are updated by those specs for human review; CI asserts DOM layout, not pixels.
