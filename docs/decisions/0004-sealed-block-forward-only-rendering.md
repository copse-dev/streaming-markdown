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
O(tail) per update instead of O(all blocks). Patch *target* resolution (which
committed blocks a new definition upgrades) landed with the Phase 2
sealed-commit slice below; remaining is the event-driven emitter itself
(consume `ScanAdvance.sealed` instead of re-deriving the delta from
`settledTailStart` each commit).

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

**Second slice landed — sealed-commit memos and targeted link-reference
patches** (`streaming-frozen-tail.ts` `commitRanges`/`patchFrozenLinkRefs`,
`streaming-commit-memo.test.ts`): the generic commit path now trusts — under
byte-exact proofs — the DOM the previous commit produced, instead of
re-sanitizing + re-parsing + re-diffing it:

- **Delta adopt-in-place / extension adoption**: the blocks settling in a
  commit usually ARE last frame's tail. When the delta (or its first
  top-level part) equals the memoized tail byte-for-byte at the same root,
  position, and '\n' seam, the frozen boundary advances over the live nodes
  with no sanitize/parse/diff; only genuinely new parts are parsed. The
  partial split is taken only when both halves are independently freezable —
  the same per-fragment-sanitize assumption the frozen boundary itself rests
  on, at the same top-level group granularity.
- **Tail reuse**: a commit whose tail re-renders byte-identically keeps the
  live tail nodes and only trims stale trailing children. To uphold the
  memo's DOM-trust invariant, the streaming renderer sweeps its pending-tail
  artifacts BEFORE the commit morphs run (byte-equivalent to the old
  morph-side removal) and hydration invalidates the memo.
- **Targeted link-reference patches (limitation J)**: a definition arriving
  for a label that frozen content cites re-renders and morphs ONLY the frozen
  top-level parts whose source mentions a changed label — resolved against a
  verified alternating part/seam node layout, per-part bookkeeping
  accumulated at freeze time — instead of full-morphing the document per
  definition line. Symmetric over additions, removals, and value changes,
  which also absorbs the definition-run retreat (the splitter holds a
  blank-free run as one open block, so `complete` legitimately retreats past
  committed definitions and returns); the frozen boundary is now capped
  before trailing separator tokens so the prefix survives that retreat.
  Measured (5.1 kB doc, 30 definitions at the bottom each cited above, 200
  updates, jsdom): blank-separated definitions p95 32 ms → 4.2 ms, max 37 ms
  → 10.6 ms, total 1078 ms → ~310 ms, rendered chars 224 k → 19.6 k, all 30
  definitions absorbed as patches. Every skip and patch is pinned by
  timing-free diagnostics (`parsedChars`, `deltaCommitsSkipped`,
  `deltaPrefixesAdopted`, `tailMorphsSkipped`, `linkRefPatchCommits`) and
  falls back to the exact old full morph on any doubt (a citing set past
  `MAX_LINK_REF_PATCH_PARTS`, intra-list/re-root state, layout mismatch).

Remaining in this phase: sealed-event-driven rendering (consume
`ScanAdvance.sealed` instead of the delta re-derivation), and the splitter's
blank-free definition-run hold — the run still oscillates in and out of
`complete` per definition line, so a document where most parts cite version
labels (keepachangelog shape) degrades to the bounded full-morph fallback on
each flip; committing the leading already-terminated definition lines of an
open run (title-continuation permitting) would remove the flip entirely.

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

First counters landed with the Phase 2 sealed-commit slice:
`FrozenTailRenderer.parsedChars` (sanitized chars actually fed to a parse +
DOM diff, as opposed to `renderedChars`) plus per-skip counters, asserted
deterministically in `streaming-commit-memo.test.ts` — the measurement half
of this phase; the CI gate over per-update op counts is still to come.

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
