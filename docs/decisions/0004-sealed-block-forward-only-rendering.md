# 0004 — Bridging the performance gap to smd: sealed-block, forward-only rendering

Status: proposed · Relates to [#157](https://github.com/copse-dev/streaming-markdown/issues/157) (cross-library benchmark), #21 (O(tail) commits), #30 (incremental scanning), #154 (relative regression guard)

## Context

The published cross-library benchmark ([`docs/BENCHMARKS.md`](../BENCHMARKS.md))
shows this renderer 4–6× ahead of every React-based streaming renderer at
per-update p95 on long transcripts — and more than an order of magnitude behind
[smd / `streaming-markdown`](https://github.com/thetarnav/streaming-markdown).
smd's architecture is *strictly append-only*: it tokenizes each incoming chunk
exactly once, writes new DOM nodes forward, and never revisits committed output.
Ours re-tokenizes from the last safe boundary on every update, renders the tail
group, and morphs the pending DOM to match — which is precisely what buys
mid-stream GFM correctness.

The benchmark's controlled variants attribute the gap:

- **Sanitization** (`ours DOM incremental (unsafe)`): sanitizer-verified HTML
  every update is roughly a third of per-update cost under jsdom/DOMPurify
  (worst case — the native-Sanitizer browser path is cheaper).
- **Feature superset** (`ours DOM incremental (smd parity)`): footnotes and
  link reference definitions cost per-update definition scans even in documents
  that never use them (the Θ(n²) residue #30 attacks; its safe-boundary caching
  bounds but does not eliminate them). The `footnotes: false` /
  `linkReferences: false` config gates added with the parity row remove that
  cost — and quantify it.
- **Architecture** (everything left): re-tokenize from the safe boundary + tail
  re-render + DOM morph per update, versus smd's append-and-never-look-back.
  This is the dominant remaining term, and it is what this document plans to
  close.

Both our variants hold ~10–20 ms p95 per update on a 114 kB transcript — inside
a 60 fps frame budget. The gap to smd matters at the margins: very long
transcripts, low-end devices, many concurrent streams. It is a real v2
performance project, not a fire.

## Why strict append-only is impossible for GFM

We left forward-only rendering deliberately when full GFM support landed,
because several constructs are retroactive *by definition*. Any plan must
classify them honestly:

| construct | retroactivity | forward-only answer |
| :-- | :-- | :-- |
| **Tables** | `\| a \| b \|` is a paragraph until the delimiter row arrives on the *next* line, then it must become `<table>` | Bounded hold: exactly one line of lookahead (the header + separator hold, #77) |
| **Setext headings** | paragraph becomes `<h1>`/`<h2>` when the `===`/`---` underline arrives | Same one-line hold |
| **Link reference definitions** | `[foo]` renders literal until a definition arrives arbitrarily later (limitation J) | Targeted patch: re-morph only the referencing blocks when the definition map changes — never a full re-render |
| **Footnotes** | `[^1]` literal until `[^1]: …` arrives; section grows at the end | Already solved this way: #110/#133 upgrade the specific references inline and append/patch section items |
| **Loose vs. tight lists** | a blank line between items retroactively wraps every earlier `<li>`'s content in `<p>` | O(1) class toggle on the list element + CSS presentation, instead of restructuring committed children |
| **Emphasis / inline closers** | `*foo` may close many chunks later | Already tail-scoped: the pending-hold walker suppresses the undecided suffix; never retroactive past the hold |
| **Indented/lazy continuations** | a later line can extend an earlier open container across a blank | Already the *safe boundary* definition in `incremental-scan.ts` (#111): a boundary is only safe once a later terminated block seals it |

So the honest contract is **not** "never touch committed DOM" (smd's contract —
which is also why smd has no footnotes, no reference links, no loose-list
semantics, and can misrender the table-header case). It is:

> **Committed DOM receives only O(1)-bounded, targeted patches (reference
> upgrades, list-mode toggles, section appends). Everything else is append.
> Nothing is ever re-derived from scratch.**

That contract is achievable for full GFM. The codebase has been drifting toward
it one construct at a time (#21 frozen prefix, #29 intra-list freezing, #30
incremental scanning, #110/#133 footnote fast path); this plan is the
generalization.

## Where the remaining cost actually lives

Per `update()` today, even with the frozen prefix valid and no definitions in
play (`streaming-frozen-tail.ts`):

1. **Re-tokenize** the suffix past the last safe boundary
   (`IncrementalSourceScanner.tokenize`) — O(open tail), but re-done every
   chunk, and long open containers (a streaming list/quote/fence) keep the tail
   long.
2. **Collect definitions** over the committed tokens
   (`collectLinkReferenceDefinitions` cached + suffix merge;
   `collectFootnoteDefinitions` per update) — now skippable via the
   config gates, but on by default.
3. **Re-render the tail group** to an HTML string (`renderBlocks` over the
   delta + tail tokens) and **serialize + compare** against the frozen state
   (`serializeLinkRefs`, prefix byte-check, `tokenStraddles`).
4. **Morph the DOM** (`streaming-dom-morph.ts`) — minimal patches, but the diff
   itself is recomputed from strings each frame.

smd does none of 1–4: its tokenizer state machine *is* the commit decision, so
each byte is looked at once. The asymmetry is that our renderer re-derives
"which blocks can no longer change" from scratch every update, when the
tokenizer already knows.

### Case study: the unbounded-fallback trap (found by this benchmark)

The first full run of the #157 harness after v0.11.0 showed our sanitized and
unsafe incremental rows ~13× slower on `CHANGELOG.md` — because a release
entry contained the literal prose `an open <details> (#138)`. Under the
default passthrough HTML policy that unclosed tag makes
`hasUnfreezableRawHtml` reject the delta, and since the guard re-evaluates the
same growing delta every commit, **every subsequent update full-morphs: one
bare tag permanently degrades the rest of the stream to O(n²)** (measured:
1.77M rendered chars for a 15 kB document, vs 53 k with the tag in a code
span — and it swallowed the long-transcript fixture too, where CHANGELOG sits
early in the concatenation). The parity row was immune only because
`htmlPolicy: 'escape'` literalizes the tag.

The content is fixed (`gen-changelog.mts` now code-spans bare tags), but the
trap is real for LLM output, which emits `<details>`/`<div>` in prose
routinely. It sharpens the Phase 2 requirement: in the whole-string render,
content after an open raw element belongs *inside* it, so the sealed-mode
emitter must support **re-rooting the append point into an open raw element**
(an insertion-point stack) rather than treating the imbalance as
unfreezable — turning today's permanent O(n²) fallback into ordinary O(tail)
appends under a shifted root. Until then, the fallback cost is the single
biggest real-world hazard this plan removes.

### The direct-DOM floor (measured)

The last theoretical parity item vs smd is a **direct-DOM block builder**:
constructing committed block nodes with `createElement`/`createTextNode` the
way smd does, instead of the current committed pipeline (render block → HTML
string → sanitize → `innerHTML` parse into a morph template → diff). Whether
that is worth an emitter fork is an empirical question — what fraction of the
remaining per-update parity-config cost is the HTML-string **parse**, versus
the string **render**, versus the **diff**? Measured (2026-07-12, same
machine/day for all rows): temporary stage counters at the pipeline seams
(`renderBlocksToParts`/`renderListItemsSlice`, `sanitizeRenderedMarkdown`,
`setPresanitizedHtml` split into detached-template vs live-element
assignments, `morphChildren`, `IncrementalSourceScanner.tokenize`,
`renderPendingLine`, and whole-`update()`), replaying the published
methodology — long transcript (118.9 kB), 200 updates, smd-parity config —
mean of 5 runs after warmup, probe overhead ≤ 6% of p50. Baselines that day:
parity p50 3.38 ms jsdom / 1.80 ms Chromium, smd 0.31 / 0.70.

Stage attribution, share of total `update()` JS time per run (200 updates, of
which 182 commit; "parse committed" is the `innerHTML` parse of the sanitized
delta+tail morph templates — ~476 kB re-parsed per run; "parse pending" is the
live pending-element `innerHTML` writes):

| stage | jsdom (of 1160 ms/run) | Chromium (of 337 ms/run, layout forced) |
| :-- | --: | --: |
| string render (`renderBlocks*`) | 203 ms — 17.5% | 151 ms — **45.0%** |
| parse committed (`innerHTML` templates) | 431 ms — **37.2%** | 27.7 ms — **8.2%** |
| diff (`morphChildren`) | 218 ms — 18.8% | 32.4 ms — 9.6% |
| tokenize (incremental scan ×2) | 57 ms — 4.9% | 54.9 ms — 16.3% |
| pending-line render + pending `innerHTML` | 57 ms — 5.0% | 10.8 ms — 3.2% |
| sanitize (passthrough) | 1.9 ms — 0.2% | 0.9 ms — 0.3% |
| other (split, table/pending DOM sync, …) | 192 ms — 16.5% | 58.6 ms — 17.4% |

And the parse-vs-build microbench, replaying the run's **actual captured
template strings** (280 strings, 476 kB per run): (a) `innerHTML` parse as
today; (b) direct build — `createElement`/`createTextNode`/`setAttribute`
walking a precomputed spec of the identical tree (a *lower bound* on a real
direct emitter, which would also pay the inline logic currently inside
"string render"); (c) hybrid shell build — `createElement` the block shells,
`innerHTML` only each block's inline content:

| per run | jsdom | Chromium |
| :-- | --: | --: |
| (a) `innerHTML` parse (current) | 351 ms | 16.3 ms |
| (b) direct build (identical tree) | 79 ms (4.5× cheaper) | 13.3 ms (1.2× cheaper) |
| (c) shell build + inline `innerHTML` | 367 ms (**slower**) | 22.2 ms (**36% slower**) |

Conclusions, in decision order:

- **The floor is not where jsdom said it was.** jsdom's JS HTML parser makes
  parse-committed the biggest stage (37%) and direct building look 4.5×
  cheaper — a projected ~29% parity win if one only ever benchmarks jsdom.
  In Chromium the same strings parse ~15× faster: the parse is **8.2%** of
  per-update JS, and hand-building the identical tree saves only ~18% *of
  that* — a net ≈ **1.5% projected win** for a full direct-DOM builder, ≈ 12%
  even if both parse and diff dropped to zero (which requires the sealed-event
  emitter below anyway, not a parse swap). Both are far under any bar that
  would justify the risk.
- **The hybrid (block shells direct, inline via `innerHTML`) is a strict
  loss** in both engines: block shells are a trivial fraction of the parse —
  inline content dominates — and many small `innerHTML` writes cost more than
  one big one.
- **What actually remains is our own work, not the parser's**: string render
  45% + tokenize 16% + other 17% of Chromium per-update time is the
  re-derive-the-tail-each-commit architecture. That is exactly what sealed
  events (Phases 1–2) attack, and nothing a DOM builder helps with.
- **Even inside a future sealed-event emitter, direct building buys almost
  nothing over render-once + parse-once**: at Chromium parse throughput the
  once-per-block string parse is within ~20% of a hand-built tree, for zero
  new correctness surface.

The correctness surface a direct builder would have had to carry (and now
does not need to): the committed contract is byte-equality with
`sanitizeRenderedMarkdown(renderMarkdownUnsafe(complete))`, so a builder must
reproduce the HTML **parser's** tree exactly — text-node boundaries (the `'\n'`
seams stay separate text nodes only because top-level parts end in elements;
the single-parse range morph relies on this), entity decoding byte-for-byte
(numeric, named, legacy-without-semicolon), attribute order
(`attributesEqual` is order-sensitive), and the parser-context quirks the
freeze guards currently *ask the parser about* (`openElementChainAtEof`
probes foster-parenting, formatting-element reconstruction, CDATA
swallowing — a builder cannot probe a parser it bypasses). The sanitized
default is string-in (DOMPurify / native Sanitizer), so direct building could
only ever serve passthrough/escape-all configs — a config-gated second
emitter, against a tight bundle budget, for a measured ~1.5%.

**Decision: do not build a direct-DOM block builder — in either the current
pipeline or the Phase 2 emitter.** The committed-path floor on real engines
is set by the string render and tokenize stages; keep funding sealed-block
events (tail latency and cliff removal, per the Phase 0 verdict) and re-run
this attribution if the render/tokenize shares ever stop dominating.

## Plan: sealed-block events

Make the tokenizer emit **sealed-block events** — "this block can never change
again; render it exactly once" — and make the streaming renderer consume events
instead of re-deriving stability by rescanning.

### Phase 0 — Attribution and guardrails (done / in flight)

- Cross-library benchmark with unsafe + smd-parity variants (#157) separates
  sanitizer cost and feature-superset cost from architecture cost. ✔
- `footnotes` / `linkReferences` config gates make the definition scans
  optional and measurable. ✔
- Relative regression guard (`npm run bench`, #154) gates CI on our own
  numbers, so each phase below lands only if it moves them. ✔
- **Real-browser tier: landed and run** (`npm run bench:competitors:browser`,
  Chromium via playwright-core, same corpus/chunking, layout forced per
  update). First results, long transcript (114 kB, 200 updates): smd p50
  0.5 ms / p95 1.0 ms; **ours smd-parity p50 1.8 ms / p95 3.0 ms; ours
  sanitized (DOMPurify backend) p50 2.3 ms / p95 4.9 ms**. Two decisions fall
  out. (1) jsdom overstated the architectural gap by an order of magnitude:
  ~3–4× in a real engine, not ~24× — and every configuration is deep inside
  frame budget, so the *median frame-time* case for Phases 2–3 is weak on
  current hardware. (2) What the browser numbers do NOT dilute is the
  fallback cliff (the `<details>` case study below happens in real engines
  identically) and the tail (`max` per update still hits 35–50 ms on the long
  transcript — a dropped frame — where smd's worst update is 1.6 ms). The
  sealed-block project's payoff is therefore **tail latency and cliff
  removal**, not medians; scope Phases 2–3 accordingly (the re-rooted append
  point and bounded fallbacks first, wholesale emitter replacement last).

### Phase 1 — Seal events from the incremental scanner

**Status: landed** — `IncrementalSourceScanner.advance()` returns a
`ScanAdvance` (sealed tokens fire-once in document order, the forming region,
sealed link-ref/footnote-definition deltas, and an explicit `reset` on
rewrite), verified headless against `tokenizeBlocks`/collector equivalence at
every prefix (`incremental-scan-sealed.test.ts`). The scanner also maintains
the footnote-definition map incrementally (`footnoteDefs()`), now threaded
into the frozen-tail commit path — the footnote share of limitation K is
O(tail) per update instead of O(all blocks). Remaining for Phase 2: patch
*target* resolution (which committed blocks a new definition upgrades) and the
event-driven emitter itself.

`incremental-scan.ts` already computes the safe boundary (the sealing
predicate: a complete blank after a non-extendable block, or a later terminated
block after an extendable one, #111). Today it returns tokens; instead, let it
emit a monotone event stream per appended chunk:

- `sealed(token, sourceSlice)` — token can never re-tokenize differently; will
  fire exactly once per block, in document order.
- `forming(tokens, sourceSlice)` — the open tail, replayed each update
  (today's pending region).
- `patch(kind, target)` — a document-global fact changed: a link-ref /
  footnote definition arrived (upgrade referencing blocks), a list flipped
  loose (toggle its element), a table separator confirmed (promote held
  paragraph). Each carries the *specific* target set, computed from the
  definition map delta (the #110 mechanism, generalized).

This is a parser-architecture change in *shape* but not in *logic*: the
predicates all exist; they move from pull (rescan and compare) to push (emit
when the state machine seals). The event stream is testable headless against
`tokenizeBlocks` equivalence, independent of any DOM work.

### Phase 2 — Render-once commit path

**Status: first slice landed — re-rooted append points and probe-verified
freezes** (`streaming-frozen-tail.ts`, `streaming-reroot.test.ts`), scoped per
the Phase 0 verdict (cliffs and tails before medians):

- The unfreezable-raw-HTML guard's string count is now refined by an inert
  `DOMParser` canary probe: a delta whose imbalance the parser self-heals (the
  changelog case — `<details>` closed by its `</li>`) proves
  concatenation-safety and **freezes normally**; a delta that genuinely leaves
  a safe container element (`details`/`div`/`section`/…) open **re-roots** —
  the open element becomes the live append target and later blocks freeze
  inside it, exactly where the whole-string parse puts them, under both a
  surviving container and a sanitizer-unwrapped one (both shipped backends
  keep a dropped element's children in place, which per-fragment rendering
  reproduces). Formatting-element reconstruction, foster-parenting, and
  CDATA-swallowing shapes are detected by the same probe and keep the old
  full-morph fallback; a frame's close tag costs one full morph, after which
  the balanced region freezes wholesale.
- Measured on the v0.11.0 changelog (15 kB, 200 updates, same machine,
  base = Phase 1): details-in-list-item **6868 ms → 429 ms** (1.77 M → 55.7 k
  rendered chars); bare top-level details **8245 ms → 398 ms** (1.83 M →
  53.6 k). The cliff is gone in both shapes; clean-content numbers are
  unchanged, and `synthetic/raw-html-details (#0004)` is now a published
  benchmark fixture so it cannot silently regress.

Remaining in this phase: sealed-event-driven rendering (consume
`ScanAdvance.sealed` instead of the delta re-derivation), and targeted
link-reference patches (limitation J still full-morphs on a late definition —
the other fallback cliff, and the likely source of the residual per-update
`max` outliers).

A new emitter consumes the events: `sealed` blocks render to DOM exactly once
and are appended (no string re-render, no serialize-compare, no morph);
`forming` renders into the pending container as today (holds included);
`patch` applies its targeted mutation. The frozen-prefix machinery
(`streaming-frozen-tail.ts`) stops being a per-update *decision* and becomes a
debug assertion: sealed output must equal what a fresh
`sanitizeRenderedMarkdown(renderMarkdownUnsafe(complete))` produces —
exactly the invariant the streaming convergence fuzz already checks, so the
existing suite carries over as the correctness oracle.

Fallbacks stay: a prefix rewrite (message edit/regeneration), an unfreezable
raw-HTML span, or any event-stream assertion failure drops that stream to the
current full-morph path — correct, just not fast — mirroring today's
`fullMorph` escape hatch.

### Phase 3 — Patch-budget contract

Promote the contract to an enforced invariant: per update, work is
O(new bytes) + O(pending tail) + O(1) patches. Add op-count assertions to the
#154 bench guard (DOM mutations per update, bytes re-tokenized per update) so a
regression in *shape* fails CI even when wall-clock noise hides it.

### Expected end state

Per-update cost collapses to: tokenize the new bytes once + inline-render the
pending tail + amortized-O(1) DOM appends — smd's cost model plus a bounded
hold/patch tax, with none of smd's correctness sacrifices. Sanitization stays
at the sink for sealed fragments (paid once per block, not once per update),
which also removes the current sanitize-per-update multiplier without giving up
the safe default.

## Risks and why now is not yet the time to build

- **This is the riskiest kind of change** — the changelog documents the
  mid-stream bugs pure forward-only rendering caused before the current design
  (#77 table-header misrender; #119, #122, #123 pending-motion regressions).
  The mitigations are the convergence fuzz, the #154 guard, and landing the
  event stream (Phase 1) headless before any DOM change.
- **The current numbers are already inside frame budget**; the payoff is at
  the tails. If the Playwright tier shows layout dominating real-browser frame
  times, Phases 2–3 should wait.
- **Two emitters during migration** (event-driven and frozen-tail) is real
  maintenance surface; Phase 2 must replace, not add — the ARCHITECTURE.md
  "intentional duplication" note already caps how many emitters this codebase
  tolerates.

Decision: adopt the contract ("O(1) targeted patches, everything else
append"), land Phase 0 now, and gate Phases 1–3 on the real-browser numbers.
