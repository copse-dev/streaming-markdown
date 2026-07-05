# Gap analysis: `@copse/streaming-markdown` vs. streamdown / remend

> Decision record. Tracks [#12](https://github.com/copse-dev/streaming-markdown/issues/12).
> Compares this package against Vercel's [streamdown](https://github.com/vercel/streamdown)
> and its streaming primitive [remend](https://github.com/vercel/streamdown/tree/main/packages/remend),
> and sets a policy for how we treat [remend's test corpus](https://github.com/vercel/streamdown/tree/main/packages/remend/__tests__).

## The framing that matters

These are not the same kind of tool, so a flat "A vs B" is the wrong axis:

| | **copse/streaming-markdown** | **remend** | **streamdown** |
| --- | --- | --- | --- |
| What it is | Full renderer (markdown → HTML/DOM) | String **pre-processor** ("self-healing") | React **component** |
| Streaming strategy | Native incremental state machine — holds/reveals partial tokens via designed pending states | Append synthetic closing markers, then re-parse the whole string | remend + remark/rehype, re-render each token |
| Framework | Host-independent | Framework-agnostic (healer only) | React-bound |
| Deps | `entities`, `dompurify`, `highlight.js` | **zero** | React + remark + rehype + shiki + katex + mermaid |
| Streaming-layer output | HTML string **or** incremental DOM patches | a *healed markdown string* (still needs a renderer) | rendered React tree |

**Two philosophies:**

- **Heal-then-reparse (remend).** Cheap and portable, but the completion is an *optimistic
  guess* — it inserts a marker the model never sent, and re-parses the whole document every
  token. The transient frame can show a completion that later changes.
- **Native incremental (copse).** More code, but transient frames are *engineered* rather than a
  side-effect of auto-closing, and the DOM is patched incrementally instead of re-parsed O(n) per
  token.

## Gap analysis

### Where copse is ahead

- **Renderer-complete and host-independent.** streamdown gives nothing outside React; remend gives
  only the string-heal step (you still build the renderer). copse is the whole pipeline, with
  injectable link decoration (`LinkDecorator`).
- **Measurable CommonMark conformance.** The ~650-example spec suite runs with a pinned baseline
  (`commonmark-conformance.test.ts`, ~84% of in-scope examples). remend's healing is heuristic;
  streamdown's final fidelity is whatever remark-gfm does, ungated by a spec harness.
- **Convergence guarantee under incremental patching.** `streaming-convergence.test.ts` fuzzes
  every prefix cut and asserts that streaming *any* chunking converges to the byte-identical static
  render — **while patching the DOM incrementally**. remend/streamdown get convergence trivially by
  re-rendering from scratch each token; copse proves it holds without paying the reparse.
- **Two emitters** (string HTML + incremental DOM) with a benchmark harness
  (`scripts/bench-streaming.mts`) that catches super-linear regressions.

### Where streamdown / remend is ahead

- **KaTeX / math** — copse has none; remend explicitly heals `$$…`. A real feature gap.
- **Shiki** highlighting (finer-grained than highlight.js) and a polished Tailwind/shadcn drop-in
  *if you are already a React app*.
- **remend-the-primitive is smaller** than copse-core (zero deps vs `dompurify` + `highlight.js`).
- Larger community / vendor backing.

## Which to pick

For a **framework-agnostic renderer with high partial-stream fidelity → copse**, clearly.
streamdown is only a candidate if you are already all-in on React and happy to ship
shiki + katex + mermaid + remark. remend alone is not a competitor to copse — it competes with *one
internal step* of copse (the "don't flash raw syntax" logic), and copse's hold-and-reveal approach
to that step is architecturally stronger than remend's guess-and-append because it never commits a
wrong intermediate.

Honest caveats: copse costs a hand-rolled tokenizer to maintain, and it lacks math today.

## Policy: how we treat remend's `__tests__`

**Adopt the input corpus; do not adopt the assertions.**

remend's tests assert `remend(inputString) === healedString` — a claim about *which closing markers
to append to a raw string*. copse does not emit a healed markdown string; it emits HTML/DOM with
pending states. **The output types do not match, so the fixtures cannot run verbatim as pass/fail.**

Conforming to remend's *expected outputs* would also regress copse by design. Example: remend turns
`[documentation` into `[documentation](streamdown:incomplete-link)` — a fake href. copse's
`revealFormingLink` (`render-pending-line.ts`) instead shows just the label text with **no** href
until the real URL arrives, so it never renders a bogus/partial/dead link. Matching remend's string
would break that invariant.

The right move:

1. Mine remend's `__tests__` as a checklist of streaming edge-case **inputs**, fed into copse's
   existing `streaming-convergence` / `streaming-pending-matrix` harness.
2. Assert copse's **own** invariants on each: (a) no raw marker flashes in any prefix frame, (b) the
   final render is CommonMark-correct, (c) every prefix converges to the same final DOM.
3. Use it for **gap discovery** — their suite surfaces constructs copse may not cover yet.

### Follow-up checklist (gap discovery from the remend corpus)

- [ ] Port the remend streaming input corpus into a convergence / no-flash test (inputs only,
      copse invariants as assertions).
- [ ] **KaTeX / `$$…$$` math** — currently unsupported. Decide: known-gap vs. implement.
- [ ] **Single tilde** (`20~25`) — confirm lone `~` stays literal while streaming (documented in
      the README; add explicit coverage).
- [ ] **Comparison operators** (`20 < 30`) — confirm no spurious tag/entity mid-stream.
- [ ] **Images** (`![alt](partial`) — confirm graceful reveal, paralleling `revealFormingLink`.
- [ ] **Underscore-in-identifier** (`foo_bar_baz`) — not italicised mid-stream.
- [ ] Document the divergence policy (label-only forming links vs. remend's placeholder href) so it
      is not "fixed" later by mistake.

## Rationale sharpening (for the pitch / README)

- **"Not bound to React"** — strongest point. Sharpen to: copse is the only framework-agnostic
  *renderer* of the three.
- **"CommonMark + GFM compatibility"** — true and measured, but state the deliberate cap: copse
  escapes raw HTML by design (2/44 HTML-blocks, 8/20 raw-inline), so it is "structural CommonMark
  minus raw-HTML passthrough, by security choice."
- **"100% partial-stream fidelity"** — name it precisely: **chunk-invariant convergence**
  (`streaming-convergence.test.ts`). Streaming any chunking yields the byte-identical static render,
  proven under incremental DOM patching — not the free version you get from re-rendering everything.
- **"Small — x kb over y kb"** — weakest bullet; needs real gzipped `dist` numbers. True vs
  streamdown-the-product (React + shiki + katex + mermaid); **false** vs remend-the-primitive
  (zero-dep). Be explicit about which competitor and which config, or drop it.
