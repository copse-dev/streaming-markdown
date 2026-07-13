# 0001 — `@copse/streaming-markdown` vs. remend/streamdown, and a conformity policy for the remend corpus

Status: accepted · Relates to [#12](https://github.com/copse-dev/streaming-markdown/issues/12)

Decision record capturing how this package compares to Vercel's
[streamdown](https://github.com/vercel/streamdown) and its streaming primitive
[remend](https://github.com/vercel/streamdown/tree/main/packages/remend), what we
adopt from remend's test suite, and which divergences are deliberate. For the
design invariants and the conformance baseline this references, see
[ARCHITECTURE.md](../ARCHITECTURE.md).

## The framing that matters

These are not the same kind of tool, so a flat "A vs B" is the wrong axis:

|                        | **copse/streaming-markdown**                   | **remend**                                       | **streamdown**                          |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| What it is             | Full renderer (markdown → HTML/DOM)            | String **pre-processor** ("self-healing")        | React **component**                     |
| Streaming strategy     | Native incremental state machine — holds/reveals partial tokens via designed pending states | Append synthetic closing markers, then re-parse the whole string | remend + remark/rehype, re-render each token |
| Framework              | Host-independent                               | Framework-agnostic (healer only)                 | React-bound                             |
| Deps                   | **zero required** (`dompurify`, `highlight.js`, `entities`, … all optional) | **zero**                             | React + remark + rehype + shiki + katex + mermaid |
| Streaming-layer output | HTML string **or** incremental DOM patches     | a *healed markdown string* (still needs a renderer) | rendered React tree                  |

**Two philosophies:**

- **Heal-then-reparse (remend):** cheap, portable, but the completion is an
  *optimistic guess* — it inserts a marker the model never sent and re-parses the
  whole document every token. A transient frame can show a completion that later
  changes.
- **Native incremental (copse):** more code, but transient frames are engineered
  (hold-and-reveal) rather than a side-effect of auto-closing, and the DOM is
  patched incrementally instead of re-parsed O(n) per token.

## Gap analysis

**Where copse is ahead**

- Genuinely renderer-complete **and** host-independent. streamdown gives nothing
  outside React; remend gives only the string-heal step (you still build the
  renderer). copse is the whole pipeline with an injectable `LinkDecorator`.
- **Measurable CommonMark conformance** — the ~650-example spec suite with a
  pinned baseline. remend's healing is heuristic; streamdown's final fidelity is
  whatever remark-gfm does, ungated by a spec harness. (Live numbers below.)
- **Convergence guarantee under incremental patching** —
  `streaming-convergence.test.ts` fuzzes every prefix cut and asserts streaming
  any chunking converges to the byte-identical fresh render *while patching the
  DOM incrementally*. remend/streamdown get convergence trivially by re-rendering
  from scratch each token; copse proves it holds without the reparse.
- Two emitters (string HTML + incremental DOM) with a benchmark harness that
  catches super-linear regressions.
- **Pluggable math with streaming holds (#70/#75/#78).** `$…$` / `$$…$$` /
  `\(…\)` / `\[…\]` prose math and ```` ```math ```` fences are recognized and
  KaTeX-rendered via an injectable math renderer; KaTeX is never
  bundled, and prose-math syntax is opt-in (it turns on when a renderer is
  registered), so output stays byte-identical for hosts that never register one.

**Where streamdown/remend is ahead**

- Shiki highlighting (finer-grained than highlight.js) and a polished
  Tailwind/shadcn drop-in *if you are already a React app*.
- remend-the-primitive is smaller than copse-core (zero deps vs. `dompurify` +
  `highlight.js`).
- Larger community / vendor backing.

### Conformance numbers (live baseline)

The headline figures in the issue predate the current baseline. From
`tests/fixtures/commonmark/conformance-baseline.json` (`summaryBySection`) at the
time of writing:

- **579 / 652** official spec examples pass at rest under the pinned
  `htmlPolicy: 'escape'` harness (~89%) — this is `passing.length` / `total` in the
  escape baseline JSON, not a figure typed here. (The shipping `passthrough`
  default passes a few more — **583 / 652** — measured in
  `conformance-baseline-passthrough.json`.)
- Two sections fail **by design** because the escape harness escapes untrusted HTML
  rather than passing it through (sanitize-at-the-sink): **HTML blocks 2/44** and
  **Raw HTML 8/20**. Excluding those **64 HTML examples**, the in-scope ceiling is
  **588 examples**, of which **569 pass (~97%)** under escape (**572** under
  passthrough).

So the honest phrasing is "structural CommonMark minus raw-HTML passthrough, by
security choice." Treat these figures as approximate and read `summaryBySection`
in the baseline JSON for the live per-section counts; they move as non-HTML
conformance grows. Do **not** re-baseline in this doc's PR.

## Recommendation: which to pick

For a **framework-agnostic renderer with high partial-stream fidelity → copse**,
clearly. streamdown is a candidate only if you are already all-in on React and
happy to ship shiki + katex + mermaid + remark. remend alone is not a competitor
to copse — it competes with *one internal step* of copse (the "don't flash raw
syntax" logic), and copse's hold-and-reveal approach to that step is
architecturally stronger than remend's guess-and-append because it never commits a
wrong intermediate.

Honest caveat: copse costs a hand-rolled tokenizer to maintain.

## Conformity policy: adopt inputs, not assertions

**We adopt remend's input corpus; we do not adopt its assertions.**

remend's tests assert `remend(inputString) === healedString` — a claim about
*which closing markers to append to a raw string*. copse does not emit a healed
markdown string; it emits HTML/DOM with pending states. **The output types do not
match, so the fixtures cannot run verbatim as pass/fail.**

Worse, conforming to remend's *expected outputs* would regress copse by design.
Example: remend turns `[documentation` into
`[documentation](streamdown:incomplete-link)` — a fake href. copse's
`revealFormingLink` (`render-pending-line.ts`) instead shows just the label text
with **no** href until the real URL arrives (never a bogus/partial/dead link).
Matching remend's string would break a copse invariant.

**The right move:**

1. Mine remend's `__tests__` as a checklist of streaming edge-case **inputs**, fed
   into copse's existing `streaming-convergence` / `streaming-pending-matrix`
   harness.
2. Assert copse's **own** invariants on each: (a) no raw marker flashes as
   structural markup in any prefix frame, (b) once the input commits, the streamed
   render equals the static `renderMarkdown` render, (c) every prefix converges to
   the same fresh full render.
3. Use it for **gap discovery** — their suite surfaces constructs copse may not
   cover.

This is implemented in [`src/remend-corpus.test.ts`](../../src/remend-corpus.test.ts).

## Deliberate divergences (do not "fix" these later by mistake)

- **Label-only forming links.** A forming link/image reveals only its label text
  with no `href`/`src` until the real destination arrives. remend emits a
  placeholder href (`streamdown:incomplete-link`); copse deliberately never
  renders a dead/partial link. Enforced by `revealFormingLink`
  (`render-pending-line.ts`) and asserted in `streaming-link-label.test.ts` and
  the new corpus test.
- **Raw HTML escaped by design.** Untrusted HTML is escaped, not passed through
  (sanitize-at-the-sink). This is why HTML blocks (2/44) and Raw HTML (8/20) cap
  out; a benign attribute-less inline allowlist (`b i u s del ins sub sup kbd mark
  br`) is the only passthrough. See ARCHITECTURE "Raw-HTML policy".
- **Math is supported, renderer-injected (#70/#75/#78).** `$…$` / `$$…$$` /
  `\(…\)` / `\[…\]` prose math and ```` ```math ```` fences are recognized and
  KaTeX-rendered through an injectable math renderer; KaTeX is never bundled and prose-math
  syntax is opt-in (on once a renderer is registered), so output is byte-identical
  for hosts that never register one. See ARCHITECTURE "Pluggable math renderer".

## Follow-up checklist (gap discovery from the remend corpus)

Every item below is either wired as a real test in `src/remend-corpus.test.ts`
(feeding the input through copse's convergence / no-flash machinery) or documented
here as a deliberate known gap.

| Item | Status |
| --- | --- |
| Port the remend streaming input corpus into a convergence/no-flash test (inputs only, copse invariants as assertions). | **Done** — `src/remend-corpus.test.ts` asserts invariants (a) no marker flash, (b) committed == static, (c) prefix convergence. |
| KaTeX / `$$…$$` math — decide known-gap vs. implement. | **Shipped** (#70/#75/#78) — prose math (`$…$`/`$$…$$`/`\(…\)`/`\[…\]`) and ```` ```math ```` fences, KaTeX-rendered via an injectable math renderer; opt-in prose syntax keeps output byte-identical until enabled. |
| Single tilde (`20~25`) stays literal while streaming. | **Covered** — no `<del>`/`<s>` in any frame; a half-open trailing `~` is held, the full input reveals `~` literally. |
| Comparison operators (`20 < 30`) — no spurious tag/entity mid-stream. | **Covered** — `<` stays escaped; no `a`/`em`/`strong`/`del` element in any frame. |
| Images — forming `![alt](partial` / `[alt](partial` reveal gracefully. | **Covered** — no `<img>`/`<a>`, no partial `src`/destination in any frame; label revealed. |
| Underscore-in-identifier (`foo_bar_baz`) not italicised mid-stream. | **Covered** — no `<em>`/`<strong>` in any frame; text stays literal. |
| Document the divergence policy (label-only forming links vs. remend's placeholder href). | **Done** — see "Deliberate divergences" above. |

## Rationale sharpening (for whoever writes the pitch)

- **"Not bound to React"** — strongest point: copse is the only framework-agnostic
  *renderer* of the three.
- **"CommonMark + GFM compat"** — true and measured, but state the deliberate cap:
  copse escapes raw HTML by design (2/44 HTML-blocks, 8/20 raw-inline), so it is
  "structural CommonMark minus raw-HTML passthrough, by security choice."
- **"100% partial-stream fidelity"** — name it precisely: **chunk-invariant
  convergence** (`streaming-convergence.test.ts`) — streaming any chunking yields
  the byte-identical static render, proven under incremental DOM patching (not the
  free version you get from re-rendering everything).
- **"Small — x kb over y kb"** — weakest bullet; needs real gzipped `dist`
  numbers. True vs. streamdown-the-product (React + shiki + katex + mermaid),
  **false** vs. remend-the-primitive (zero-dep). Be explicit about which competitor
  and which config, or drop it.
