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
- **Next:** the planned Playwright real-browser tier for the same corpus.
  jsdom measures JS + DOM-tree work only; layout/paint may dwarf the remaining
  JS gap for the React competitors while barely moving smd or us. This decides
  how much of the project is worth funding, **before** the parser work starts.

### Phase 1 — Seal events from the incremental scanner

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
