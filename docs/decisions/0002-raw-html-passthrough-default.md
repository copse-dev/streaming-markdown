# 0002 — Raw-HTML passthrough as the default, escape as an opt-out

Status: accepted · Relates to [#600](https://github.com/copse-dev/agent-pane/issues/600)

Design note for making raw-HTML **passthrough** the default rendering behavior —
in both the at-rest `renderMarkdown` path and the streaming emitters — while
retaining the historical literal-escape behavior behind an explicit opt-out
(`htmlPolicy: 'passthrough' | 'escape'`). Read alongside the raw-HTML policy and
frozen/tail invariant discussions in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Motivation

`renderMarkdown` and the streaming path historically escaped **all** raw HTML
into literal prose (the "raw-HTML policy") except a tiny benign attribute-less
inline allowlist (`b i u s del ins sub sup kbd mark br`). That was a defensible
default when the renderer's output flowed straight to `innerHTML` with no other
gate. But the library now **mandates a sink sanitizer**
(`sanitizeRenderedMarkdown`) as the documented trust boundary — every internal
sink already routes through it, and hosts are told to as well. With that gate in
place, escaping at the renderer is redundant belt-and-braces that costs
correctness: legitimate CommonMark/GFM documents embed raw HTML (`<h2>`, `<ul>`,
`<table>`, `<div>`…), and escaping shows a wall of literal `&lt;tag&gt;` text
instead of the intended structure.

The goal is to **defer entirely to the existing sanitizer** as the sole arbiter:

- tags on the sanitizer's allowlist (`sanitize.ts`) render as real elements,
- everything else (`<script>`, `<details>`, arbitrary custom tags, event
  handlers, dangerous `href`/`src`) is stripped or unwrapped by the sanitizer
  exactly as it already does for any other input.

The sanitizer allowlist is **not widened**, no HTML is converted to markdown
syntax, and the sanitize-at-the-sink model is not weakened. Passthrough emits;
the sink decides.

## The seam

Raw HTML is handled in exactly one place at the renderer level, which is what
makes this change surgical:

- **Block-level raw HTML** is not a distinct block token. The block tokenizer
  (`block-tokenizer.ts`) has no `html_block` kind, so a `<div>`/`<table>`
  snippet is tokenized as an ordinary **prose paragraph**. Indented raw HTML is
  already reclassified to prose (`isIndentedHtmlBlock`, `indented-html.ts`) so it
  follows the same path. Both therefore render through the inline pipeline.
- **Inline-level escaping** happens in `escapeHtmlTextNodes` (`escape.ts`),
  called once at the end of `renderInlineSpans` (`inline-spans.ts`) over the
  already-assembled inline HTML string. Its `escapeHtmlOutsideSafeTags` helper
  splits the text on `<…>` runs and, per part, decides *keep verbatim* vs.
  *escape as literal text*. Today "keep" means "a renderer-generated tag
  (re-validated for forged content) or a benign inline tag."

So the entire policy lives at this one keep/escape decision. **Passthrough
widens "keep" to any syntactically well-formed HTML tag** and defers safety to
the sink; **escape leaves the decision exactly as it is today.** A lone `<`, a
`<` that never forms a tag (`a < b`, `<3`), and an unterminated `<div`
(no closing `>`) are escaped as literal text under *both* policies — only a
complete, well-formed tag is passed through. That single rule is what keeps the
two paths and the frozen/tail invariant consistent (below).

A process-wide policy slot (`html-policy.ts`, mirroring the existing
module-scoped singletons — footnote context, inline-pass registry, sanitizer
backend, math syntax) carries the choice down the deep call stack without
threading a parameter through every function. The default is `'passthrough'`.
Entry points (`renderMarkdown`, `renderStreamingMarkdown`,
`StreamingMarkdownRenderer`) resolve an optional per-call `htmlPolicy` and
set/restore the slot around their work (try/finally), the same shape
`renderMarkdown` already uses for the footnote context.

## Streaming: the frozen/tail solution

The streaming invariant (#21/#29): the **frozen** region (settled top-level
groups, rendered once and never touched again) must be **byte-identical** to the
at-rest `renderMarkdown` of the same source prefix; the **tail** (the last
still-forming group) is re-rendered each commit and may show transient pending
states.

Passthrough satisfies the frozen half **for free**, because the frozen renderer
and `renderMarkdown` are the *same shared function* under the *same* policy
slot. There is no second code path to keep in sync. The only genuinely
streaming-specific question is the **tail**: a raw-HTML tag arriving in fragments
must not flash partial or unsafe markup.

The key observation is that the passthrough escaper only ever keeps a **complete,
well-formed** tag. An in-progress tag has no closing `>` yet, so at rest it is
already escaped as text. Two consequences:

1. **No incomplete tag is ever frozen.** A block only settles when a following
   block exists (a blank line or a new block started after it), which means its
   own text — and therefore any tag on it — is complete. The block granularity
   of the freeze boundary guarantees the frozen slice only ever contains
   complete tags, and it is produced by the shared path, so byte-identity holds
   automatically. A prefix that cuts *inside* a forming tag (`<div` with no `>`)
   renders identically escaped at rest and while streaming, so a prefix cut
   there converges too.

2. **The tail needs a hold, modeled on the existing forming-construct
   machinery.** Without it, a half-typed `<div class="` would render as escaped
   literal text (`&lt;div class=&quot;`) and then flip to a real `<div>` when the
   `>` arrives — a source-flash exactly like a half-open `**`, `~~`, `$x+`, or
   `&amp` before its terminator. We add `rawHtmlTagHoldStart` to the central
   `pendingHoldIndex` walker (`inline-emphasis.ts`), composing with the entity,
   strikethrough, math, and footnote holds already there: it truncates the
   visible tail at the last unmasked `<` that begins a tag (`</?letter…` or
   `<!--`) and has not yet closed with `>`. The suppressed bytes stay in the
   `pending` source (never frozen) and reveal atomically as a real element the
   moment the tag completes. The hold is **passthrough-only** — in `escape` mode
   it is skipped so the tail reproduces today's escaped-text output exactly.

A complete-but-unpaired tag (`<div>` with no `</div>` yet) *is* emitted into the
tail and balanced by the sink (`<div></div>`); this is a transient tail state,
which the invariant explicitly permits, and it settles to the shared render on
the next block boundary. No partial `<`, no unterminated tag, and no dangerous
tag reaches a sink un-sanitized.

### Element pairing across blocks (the frozen-tail freeze guard)

Tags that pair across blank-line block boundaries (`<details>`/`<summary>`, a
hand-typed `<div>`/`<table>` split by blank lines) tokenize as *separate*
paragraph blocks, so the element opens in one committed block and closes in a
later one. At rest this is fine: `renderMarkdown` emits the whole document and
the sink parses it as **one string**, so the parser keeps the element open across
the blocks and the children land inside it.

The streaming **DOM (frozen-tail) path is different** — it renders and sanitizes
each settled block group *independently* to freeze it. Sanitizing an open
`<details>` group on its own auto-closes it, so a later body block would freeze as
a **sibling after** the element — the children spill OUT, diverging from the
at-rest tree (and, for `<details>`, showing content that should be collapsed).

The frozen-tail already had exactly this guard for unbalanced benign inline tags
(`hasUnbalancedBenignRawInline`: never freeze a delta with an open `<b>`, because
per-fragment sanitization can't reproduce the whole-string formatting-element
reconstruction). Passthrough widened what can be unbalanced across blocks, so the
guard is **generalized** (`hasUnbalancedRawHtml`, passthrough only): a delta
containing *any* unbalanced raw element forces the full-morph fallback, which
renders the whole committed prefix as one string — byte-identical to at rest. The
element stays whole in the (re-rendered) committed region until its close arrives,
then freezes normally. This degrades that stream to non-incremental commits while
the element is open (documented tradeoff), never to wrong output.

One element also needs a **pending hold**: `<details>` collapses its children by
default, so the still-forming tail (rendered as a fragment appended *after* the
committed, auto-closed element) would flash the collapsed body. While a
`<details>` is open in the committed prefix (`hasOpenDetailsElement`, passthrough
only), the streaming tail is held until the element closes — the analogue of the
inline forming-tag hold, one level up. The `<summary>` (its own block, committed
before the body streams) still streams normally.

`details`/`summary` are **not on the sink allowlist**, so a host that has not
widened it sees them unwrapped to text either way; the hold and guard matter for a
host that allowlists them (via `setSanitizeExtension`) to get real collapsible
sections. No sub-case required a feature-wide fallback to escaping.

## Security argument

The trust boundary is unchanged: the sink sanitizer (`sanitize.ts`) with its
narrow, unchanged allowlist. What changes is that the renderer stops doing a
*second, redundant* escape at emission time.

- Allowlisted tags render as elements; everything else is stripped/unwrapped;
  `<script>` and its contents are removed entirely; event handlers and
  dangerous `href`/`src` are dropped — all by the sanitizer, as today.
- The renderer's own generated tags (`<a href>`, `<strong>`, `<code>`, task-list
  `<input>`…) are well-formed and pass through under both policies; forged
  look-alikes (`<img … data-md-rendered onerror=…>`) are no longer *pre-escaped*
  by the renderer but are still neutralized by the sink's per-element gate.

The one real posture change: a host that consumes `renderMarkdown`'s **string**
output and writes it to `innerHTML` *without* sanitizing was previously partially
shielded by renderer escaping and now is not. That path was always documented as
unsupported ("the renderer returns untrusted HTML strings; hosts must sanitize"),
and every in-library sink already sanitizes — but the migration note calls it out
loudly, and `htmlPolicy: 'escape'` is the exact opt-out for a host that cannot
add a sink.

## Back-compat & migration

- **Default flips to passthrough.** Consumers on the internal streaming DOM
  path, or who call `sanitizeRenderedMarkdown` on `renderMarkdown` output (the
  documented contract), need **no change** and simply gain correct rendering of
  embedded HTML.
- **Opt back into escaping** with `htmlPolicy: 'escape'` on `renderMarkdown` /
  the streaming entry points, or the process-wide `setHtmlPolicy('escape')`.
  Escape mode is guaranteed to reproduce today's output byte-for-byte (the
  CommonMark + GFM conformance harnesses and the raw-HTML boundary suite are
  pinned to `'escape'` as executable proof).
- **A host writing unsanitized `renderMarkdown` strings to a sink must either
  add `sanitizeRenderedMarkdown` (recommended) or pass `htmlPolicy: 'escape'`.**
- **Conformance baselines are untouched** in this change: the harnesses run in
  `'escape'` mode, so the pinned CommonMark/GFM pass sets do not churn. Measuring
  the true passthrough spec ceiling is a follow-up that can re-baseline
  deliberately.
- **Downstream wiring:** the default needs no wiring; `'escape'` is opt-in. No
  consumer repo is edited in this change.
