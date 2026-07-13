# Cross-library streaming benchmarks

Published, reproducible numbers comparing this library with the other
streaming-markdown renderers people actually evaluate against
([Streamdown](https://streamdown.ai),
[react-markdown](https://github.com/remarkjs/react-markdown) with and without
the recommended block memoization,
[smd / `streaming-markdown`](https://github.com/thetarnav/streaming-markdown),
and [Incremark](https://github.com/kingshuaishuai/incremark), with
[marked](https://github.com/markedjs/marked) as the full-re-parse baseline).
Filed as #157; the harness lives in
[`bench/competitors/`](../bench/competitors/). Every library name in the
generated results tables links to its GitHub project.

**These numbers are deliberately not a CI gate.** Competitor installs are
flaky and competitor releases change speed without any action of ours, so the
[`bench-competitors.yml`](../.github/workflows/bench-competitors.yml) workflow
runs on a monthly schedule or manual dispatch and publishes an artifact. Our
own *relative* regression guard (`npm run bench`, #154) is what CI gates on.

## Methodology

Adopted from Incremark's published benchmark
([`benchmark-compare/`](https://github.com/kingshuaishuai/incremark/tree/main/benchmark-compare),
MIT), then extended where their setup under-measures what a streaming UI
actually does:

- **Chunked replay.** Each fixture is streamed in small fixed-size chunks
  (default 5 characters, matching Incremark's harness), appending to an
  accumulated document exactly the way LLM deltas arrive. By default the
  chunk size grows so no fixture exceeds 200 updates (keeps the O(n²)
  full-re-render competitors from dominating wall-clock, and bounds a jsdom
  memory quirk — see below); pass `--parity` for Incremark's exact uncapped
  5-character methodology (best combined with `--only` to compare the
  pipeline-tier parsers, which is all Incremark's own table compares).
- **One process per (fixture × library) cell.** DOMPurify's string-return
  mode retains ~1–2 MB per call under jsdom — surviving GC and window
  teardown; an upstream jsdom retention that real browsers don't exhibit
  (`bench/competitors/dom-setup.ts` documents the probes). Each cell
  therefore runs in its own child process so retention can never accumulate
  across the corpus, and a competitor crash loses one cell, not the run.
- **Median of runs.** Every (library, fixture) cell is the median-by-total of
  3 measured runs after 1 warmup, with per-update p50/p95/max recorded.
- **Two execution tiers, reported separately:**
  - *Pipeline* — headless per-chunk work, no DOM. This is what Incremark's
    published table measures: its `parser.append()` (incremental mdast build)
    against other libraries' full re-parse. Caveat inherited with the
    methodology: the per-chunk work is **not equivalent** across libraries —
    Incremark builds an AST but renders nothing, Streamdown's
    `parseMarkdownIntoBlocks` only splits blocks with marked's lexer, and our
    entries emit a complete (optionally sanitized) HTML string every chunk.
  - *DOM* — end-to-end: chunks in, live rendered DOM updated per chunk, in
    jsdom so every library pays identical DOM overhead. React-based
    competitors render through `createRoot` + `flushSync` per chunk (what a
    per-delta re-render does in an app); smd and our incremental renderer
    mutate the DOM directly. This is the tier that answers "what does the
    user's frame budget see", and per-update p95/max on the long-transcript
    fixture is the frame-time proxy.
- **Bundle size** — esbuild, browser platform, minified, es2022, code
  splitting; React and declared peer dependencies are external (all React
  competitors assume an existing React app). "Initial" counts the entry plus
  all statically imported chunks; "total" adds lazy chunks.

### Corpus

Incremark's published "6.1× vs Streamdown across 38 real files" corpus is
**not in its repository** — only two of the files are committed. We pin those
two at commit `765e77b` (SHA-256-verified at fetch time, MIT) for direct
comparability, and fill the rest of the corpus with real documents from this
repository plus the code-block-heavy case from #155:

- `incremark/P1.5_COLOR_SYSTEM_REPORT.md`, `incremark/test-md.md` — the two
  committed upstream fixtures (fetched by `fetch-corpus.mts`, gitignored).
- `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`,
  `tests/fixtures/terms-of-service-streaming.md` — real docs, mixed prose /
  lists / tables / code.
- `synthetic/code-heavy (#155)` — fenced-code-dominated (TS + Python + JSON),
  the shape where repeated re-highlighting/re-parsing goes super-linear.
- `synthetic/long-transcript` — all of the above concatenated, the
  long-conversation case where incremental architectures separate from
  re-render-everything ones.
- `synthetic/raw-html-details (#0004)` — an unclosed raw `<details>` early in
  the stream, then code-heavy content: the unbounded-fallback trap of
  [ADR 0004](decisions/0004-sealed-block-forward-only-rendering.md), kept out
  of the long-transcript concatenation (an open container legitimately
  re-parents everything after it). **Do not read this fixture's cells as a
  cross-library speed comparison** — libraries do semantically different work
  on it. Ours honors the disclosure semantics: the pending tail is *held*
  while the widget is open (#138), and under passthrough the committed content
  sits inside a genuinely collapsed element the browser doesn't lay out — so
  our sanitized/unsafe rows do far less visible work by design. smd renders
  the tag as literal text and streams everything visibly. The row exists to
  regression-guard *our own* former O(n²) fallback (multi-second on this
  fixture before the ADR 0004 Phase 2 re-rooting); the parity row
  (`htmlPolicy: 'escape-all'`, tag literalized, nothing held) is the only cell
  comparable with smd here, and it shows the usual ~2–4× architectural gap.

### Fairness caveats (read before quoting a number)

- **Work per update differs by design.** Our renderers emit
  **sanitizer-verified HTML** every update (DOMPurify under jsdom — the
  native-Sanitizer fast path measured by `npm run bench:browser` doesn't
  exist there, so our sanitized numbers are worst-case). smd writes DOM text
  nodes with no sanitizer; React-based renderers rely on React's escaping;
  Streamdown additionally hardens URLs and repairs incomplete markdown;
  Incremark's core builds an AST and renders nothing at all.
- **Like-for-like vs smd:** the DOM tier includes two *unsafe* variants of
  ours with sanitization disabled (`ours DOM incremental (unsafe)` via a
  passthrough backend, and the `renderMarkdownUnsafe` string export swapped
  in with `innerHTML`) — smd's configuration, since it has no sanitizer and
  our highlighter/math/mermaid/emoji are likewise not loaded here. On top of
  those, `ours DOM incremental (smd parity)` is the fully like-for-like row:
  the unsafe configuration **plus every grammar feature smd does not support
  turned off** via `MarkdownConfig` — GFM footnotes (`footnotes: false`) and
  link reference definitions (`linkReferences: false`), which also removes
  their per-update definition scans; email autolinks
  (`emailAutolinks: false`); and raw HTML (`htmlPolicy: 'escape-all'` —
  every tag literalizes except the void `<br>`, exactly smd's
  render-tags-as-text behaviour, and the policy under which the streaming
  path runs no raw tag-balance guards at all). What stays enabled matches
  [smd's own README
  checklist](https://github.com/thetarnav/streaming-markdown#markdown-features):
  tables, task lists, strikethrough, bare `http(s)` autolinks. (Residual
  asymmetries, all negligible on this corpus: smd tokenizes `$…$` math which
  our parity row leaves off, and we keep setext headings, GFM alerts, and
  `www.` autolinks, which smd lacks.) The gap that remains in the parity row
  is purely architectural: smd appends tokens and never revisits committed
  output, while our renderer re-tokenizes the stream from the last safe
  boundary and morphs the pending tail (what buys mid-stream GFM
  correctness) — see
  [`docs/decisions/0004`](decisions/0004-sealed-block-forward-only-rendering.md)
  for the plan to close it.
- **Highlighting:** no highlighter is registered for our renderer,
  react-markdown and smd render code as plain text, so those compare
  markdown work. Streamdown's and Incremark-react's built-in highlighting is
  part of their defaults and left enabled — their code-heavy numbers include
  it.
- **jsdom is not a browser.** Layout, paint, style recalc and CLS do not
  exist in jsdom; the DOM tier measures JS + DOM-tree work only. The
  **real-browser tier** (`npm run bench:competitors:browser`,
  [`bench-browser-live.mts`](../bench/competitors/bench-browser-live.mts))
  replays the same corpus with the same chunking in Chromium via
  playwright-core, forcing a synchronous layout flush after every update, so
  per-update numbers include style recalc + layout (paint/raster excluded).
  It covers the direct-DOM contestants the architectural question is about —
  our sanitized/unsafe/smd-parity configurations and smd — and writes
  `bench/competitors/results/browser-latest.md`; it is the sizing input for
  [ADR 0004](decisions/0004-sealed-block-forward-only-rendering.md) Phase 0.
  In a real Chromium our sanitized row uses the native Sanitizer
  (`Element.setHTML`) when available — the path jsdom cannot measure.
- **Versions drift.** Every published table embeds the exact competitor
  versions and machine; compare libraries within one run only, never across
  runs or machines.

## Running it

```bash
npm ci                      # root deps (harness imports src/ directly)
npm ci --prefix bench/competitors   # isolated competitor deps
npm run bench:competitors   # fetches the pinned corpus, runs, writes results/
```

Useful flags (append after `--`): `--parity` (exact Incremark methodology),
`--fixture <regex>`, `--only <regex>` (contestant filter), `--iters N`,
`--chunk N`, `--skip-bundle`, `--no-isolate` (single-process, for debugging),
`--update-docs` (rewrites the results section below). Output lands in
`bench/competitors/results/latest.{json,md}` — the same files the scheduled
workflow uploads as its artifact.

## Results

<!-- bench-results:begin (generated by bench/competitors — do not edit by hand) -->

_Last run: 2026-07-12 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.11.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | [react-markdown](https://github.com/remarkjs/react-markdown) | [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | [streamdown](https://github.com/vercel/streamdown) | [incremark react](https://github.com/kingshuaishuai/incremark) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 307 ms | 3498 ms | 126 ms | 1252 ms | 125 ms | 16.4 ms | 380 ms | 1172 ms | 311 ms | 250 ms | 1639 ms |
| incremark/test-md.md | 18091 | 199 | 528 ms | 10645 ms | 247 ms | 3211 ms | 225 ms | 25.5 ms | 612 ms | 4238 ms | 804 ms | 1026 ms | 3423 ms |
| README.md | 9000 | 200 | 440 ms | 2972 ms | 173 ms | 1136 ms | 181 ms | 15.7 ms | 473 ms | 1030 ms | 482 ms | 496 ms | 848 ms |
| CHANGELOG.md | 14984 | 200 | 504 ms | 7998 ms | 237 ms | 2590 ms | 220 ms | 21.1 ms | 646 ms | 2660 ms | 698 ms | 798 ms | 1902 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1735 ms | 20044 ms | 847 ms | 7107 ms | 918 ms | 44.9 ms | 2170 ms | 6193 ms | 3031 ms | 2600 ms | 5237 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 288 ms | 2602 ms | 126 ms | 926 ms | 128 ms | 10.3 ms | 372 ms | 837 ms | 284 ms | 255 ms | 568 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 319 ms | 1495 ms | 204 ms | 567 ms | 195 ms | 9.05 ms | 408 ms | 349 ms | 230 ms | 135 ms | 303 ms |
| synthetic/long-transcript | 118942 | 200 | 2425 ms | 102859 ms | 1040 ms | 21632 ms | 1125 ms | 77.4 ms | 2556 ms | 21426 ms | 3807 ms | 21921 ms | 16675 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 43.2 ms | 1112 ms | 27.7 ms | 609 ms | 191 ms | 8.76 ms | 95.0 ms | 371 ms | 249 ms | 149 ms | 315 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 12.1 ms | 7.09 ms | 17.5 ms | 412 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 514 ms | 538 ms | 942 ms | 1982 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 5.20 ms | 2.94 ms | 8.80 ms | 156 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 108 ms | 105 ms | 196 ms | 215 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 5.62 ms | 3.11 ms | 9.08 ms | 159 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.39 ms | 0.30 ms | 0.61 ms | 6.96 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 12.8 ms | 7.52 ms | 17.7 ms | 385 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 107 ms | 115 ms | 185 ms | 290 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 19.0 ms | 17.3 ms | 36.0 ms | 57.1 ms |
| [streamdown](https://github.com/vercel/streamdown) | 110 ms | 95.5 ms | 231 ms | 261 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 83.0 ms | 78.4 ms | 157 ms | 270 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 209 ms | 2417 ms | 11.8 ms | 36.1 ms | 42.2 ms |
| incremark/test-md.md | 18091 | 199 | 746 ms | 6671 ms | 24.9 ms | 205 ms | 191 ms |
| README.md | 9000 | 200 | 315 ms | 2124 ms | 35.7 ms | 7.32 ms | 78.3 ms |
| CHANGELOG.md | 14984 | 200 | 720 ms | 5273 ms | 23.5 ms | 194 ms | 176 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1751 ms | 13774 ms | 966 ms | 64.0 ms | 592 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 271 ms | 1938 ms | 14.8 ms | 48.8 ms | 47.9 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 26.7 ms | 918 ms | 12.0 ms | 7.45 ms | 11.5 ms |
| synthetic/long-transcript | 118942 | 200 | 6077 ms | 69282 ms | 785 ms | 87.5 ms | 1359 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 30.7 ms | 693 ms | 13.4 ms | 11.0 ms | 12.5 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| [ours (DOM + string core)](https://github.com/copse-dev/streaming-markdown) | 95.0 kB | 31.6 kB | 95.0 kB | 31.6 kB | optional peers external (native Sanitizer path) |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 14.7 kB | 4.3 kB | 14.7 kB | 4.3 kB | dependency-free |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 114.8 kB | 35.5 kB | 114.8 kB | 35.5 kB | React runtime external (peer) |
| [streamdown](https://github.com/vercel/streamdown) | 488.3 kB | 145.4 kB | 488.3 kB | 145.4 kB | React runtime external (peer); lazy chunks = mermaid etc. |
| [incremark (@incremark/core)](https://github.com/kingshuaishuai/incremark) | 72.3 kB | 21.1 kB | 72.3 kB | 21.1 kB | parser only — no renderer |
| [incremark (@incremark/react)](https://github.com/kingshuaishuai/incremark) | 9545.0 kB | 1837.3 kB | 9545.0 kB | 1837.3 kB | React runtime + katex/mermaid peers external; shiki bundles |

<!-- bench-results:end -->

### LLM-delta-sized chunks (uncapped 5-character replay, DOM tier)

The tables above cap every fixture at 200 updates, which grows chunks to
75–600 characters. Real LLM deltas are a few characters at a time, and that
is the shape the pending-line fast path (#202) and the sealed-commit memos
(#203) target: most updates extend a plain prose sentence inside an otherwise
settled document. This section replays the two prose-bearing real documents
with Incremark's exact uncapped 5-character methodology
(`npm run bench:competitors -- --parity --update-docs` plus the
fixture/contestant filters recorded in the generated preamble). Incremental
DOM-tier contestants only — uncapped replay makes the full-re-render
competitors' cells take minutes without changing their story (they re-render
the whole document per update at any chunk size).

<!-- bench-results-parity:begin (generated by bench/competitors — do not edit by hand) -->
<!-- bench-results-parity:end -->

### Real-browser tier: Chromium, layout included

Generated by `npm run bench:competitors:browser -- --update-docs`
([`bench-browser-live.mts`](../bench/competitors/bench-browser-live.mts)) —
same corpus and chunking as the jsdom tables above, per-update timing includes
a forced style recalc + layout. Direct-DOM contestants only (see the jsdom
caveat above for why); cells are total ms with per-update p95 in parentheses.

<!-- bench-browser-results:begin (generated by bench-browser-live — do not edit by hand) -->

_Real-browser tier: Chromium via playwright-core, layout forced per update (`offsetHeight`), 2026-07-12, node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Our sanitized row used: DOMPurify backend._

| fixture | chars | updates | ours DOM incremental | ours DOM incremental (unsafe) | ours DOM incremental (smd parity) | smd (streaming-markdown) |
| :-- | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 113 ms (p95 1.30) | 60.4 ms (p95 0.70) | 56.1 ms (p95 0.70) | 24.4 ms (p95 0.30) |
| incremark/test-md.md | 18091 | 199 | 184 ms (p95 2.20) | 112 ms (p95 1.30) | 105 ms (p95 1.10) | 37.8 ms (p95 0.40) |
| README.md | 9000 | 200 | 132 ms (p95 1.30) | 74.9 ms (p95 0.80) | 76.3 ms (p95 0.80) | 15.6 ms (p95 0.20) |
| CHANGELOG.md | 14984 | 200 | 168 ms (p95 1.40) | 96.5 ms (p95 0.80) | 94.3 ms (p95 0.70) | 22.3 ms (p95 0.20) |
| docs/ARCHITECTURE.md | 49982 | 200 | 436 ms (p95 4.50) | 300 ms (p95 3.10) | 305 ms (p95 3.00) | 42.9 ms (p95 0.40) |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 79.2 ms (p95 0.80) | 43.5 ms (p95 0.40) | 42.6 ms (p95 0.50) | 11.2 ms (p95 0.20) |
| synthetic/code-heavy (#155) | 12285 | 199 | 90.2 ms (p95 0.70) | 67.6 ms (p95 0.60) | 66.1 ms (p95 0.60) | 30.3 ms (p95 0.40) |
| synthetic/long-transcript | 118942 | 200 | 600 ms (p95 4.70) | 427 ms (p95 3.20) | 418 ms (p95 3.10) | 119 ms (p95 0.90) |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 8.10 ms (p95 0.10) | 5.40 ms (p95 0.10) | 68.6 ms (p95 0.60) | 23.4 ms (p95 0.20) |

<!-- bench-browser-results:end -->
