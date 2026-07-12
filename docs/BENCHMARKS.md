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
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 359 ms | 3236 ms | 195 ms | 1132 ms | 197 ms | 19.4 ms | 440 ms | 939 ms | 302 ms | 241 ms | 1503 ms |
| incremark/test-md.md | 18091 | 199 | 575 ms | 9183 ms | 314 ms | 3047 ms | 296 ms | 24.7 ms | 678 ms | 3448 ms | 682 ms | 963 ms | 2882 ms |
| README.md | 9000 | 200 | 397 ms | 2683 ms | 218 ms | 1077 ms | 217 ms | 12.8 ms | 467 ms | 930 ms | 472 ms | 483 ms | 812 ms |
| CHANGELOG.md | 14984 | 200 | 519 ms | 6780 ms | 246 ms | 2495 ms | 242 ms | 19.0 ms | 608 ms | 2312 ms | 609 ms | 734 ms | 1538 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1885 ms | 17972 ms | 1159 ms | 6346 ms | 1106 ms | 60.4 ms | 2204 ms | 4998 ms | 2507 ms | 2363 ms | 4038 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 355 ms | 2463 ms | 220 ms | 815 ms | 197 ms | 12.6 ms | 405 ms | 677 ms | 264 ms | 247 ms | 560 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 316 ms | 1338 ms | 224 ms | 549 ms | 235 ms | 8.13 ms | 383 ms | 336 ms | 227 ms | 143 ms | 307 ms |
| synthetic/long-transcript | 118942 | 200 | 2805 ms | 81279 ms | 1898 ms | 19895 ms | 1889 ms | 74.8 ms | 3064 ms | 19511 ms | 3452 ms | 21967 ms | 15852 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 48.9 ms | 973 ms | 40.6 ms | 586 ms | 222 ms | 8.00 ms | 107 ms | 351 ms | 237 ms | 153 ms | 312 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 14.0 ms | 9.71 ms | 18.3 ms | 425 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 406 ms | 397 ms | 823 ms | 1580 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 9.49 ms | 7.53 ms | 12.8 ms | 199 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 99.5 ms | 99.8 ms | 176 ms | 219 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 9.44 ms | 7.45 ms | 15.6 ms | 198 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.37 ms | 0.30 ms | 0.61 ms | 5.67 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 15.3 ms | 11.1 ms | 20.1 ms | 398 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 97.6 ms | 105 ms | 170 ms | 250 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 17.3 ms | 15.5 ms | 35.5 ms | 51.8 ms |
| [streamdown](https://github.com/vercel/streamdown) | 110 ms | 94.7 ms | 229 ms | 290 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 78.9 ms | 72.4 ms | 164 ms | 366 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 203 ms | 2246 ms | 12.0 ms | 35.2 ms | 41.8 ms |
| incremark/test-md.md | 18091 | 199 | 721 ms | 6152 ms | 25.5 ms | 202 ms | 188 ms |
| README.md | 9000 | 200 | 296 ms | 1894 ms | 34.8 ms | 6.45 ms | 76.0 ms |
| CHANGELOG.md | 14984 | 200 | 672 ms | 5049 ms | 26.2 ms | 187 ms | 163 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1651 ms | 11644 ms | 901 ms | 67.2 ms | 561 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 241 ms | 1624 ms | 12.1 ms | 45.9 ms | 45.4 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 24.0 ms | 807 ms | 20.1 ms | 7.08 ms | 11.3 ms |
| synthetic/long-transcript | 118942 | 200 | 5499 ms | 67367 ms | 717 ms | 85.6 ms | 1208 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 28.9 ms | 599 ms | 13.4 ms | 11.2 ms | 11.9 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| [ours (DOM + string core)](https://github.com/copse-dev/streaming-markdown) | 93.4 kB | 31.2 kB | 93.4 kB | 31.2 kB | optional peers external (native Sanitizer path) |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 14.7 kB | 4.3 kB | 14.7 kB | 4.3 kB | dependency-free |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 114.8 kB | 35.5 kB | 114.8 kB | 35.5 kB | React runtime external (peer) |
| [streamdown](https://github.com/vercel/streamdown) | 488.3 kB | 145.4 kB | 488.3 kB | 145.4 kB | React runtime external (peer); lazy chunks = mermaid etc. |
| [incremark (@incremark/core)](https://github.com/kingshuaishuai/incremark) | 72.3 kB | 21.1 kB | 72.3 kB | 21.1 kB | parser only — no renderer |
| [incremark (@incremark/react)](https://github.com/kingshuaishuai/incremark) | 9545.0 kB | 1837.3 kB | 9545.0 kB | 1837.3 kB | React runtime + katex/mermaid peers external; shiki bundles |

<!-- bench-results:end -->

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
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 109 ms (p95 1.30) | 57.5 ms (p95 0.70) | 57.8 ms (p95 0.70) | 22.2 ms (p95 0.20) |
| incremark/test-md.md | 18091 | 199 | 180 ms (p95 2.00) | 111 ms (p95 1.30) | 103 ms (p95 1.20) | 43.1 ms (p95 0.50) |
| README.md | 9000 | 200 | 122 ms (p95 1.20) | 72.2 ms (p95 0.80) | 71.0 ms (p95 0.80) | 16.2 ms (p95 0.20) |
| CHANGELOG.md | 14984 | 200 | 166 ms (p95 1.40) | 91.1 ms (p95 0.70) | 94.6 ms (p95 0.80) | 22.6 ms (p95 0.20) |
| docs/ARCHITECTURE.md | 49982 | 200 | 406 ms (p95 4.10) | 288 ms (p95 3.00) | 303 ms (p95 3.00) | 38.4 ms (p95 0.30) |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 82.8 ms (p95 0.80) | 45.5 ms (p95 0.50) | 45.3 ms (p95 0.50) | 11.8 ms (p95 0.20) |
| synthetic/code-heavy (#155) | 12285 | 199 | 91.0 ms (p95 0.70) | 65.6 ms (p95 0.60) | 67.1 ms (p95 0.60) | 24.2 ms (p95 0.30) |
| synthetic/long-transcript | 118942 | 200 | 531 ms (p95 4.10) | 415 ms (p95 3.10) | 413 ms (p95 3.10) | 115 ms (p95 0.80) |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 7.40 ms (p95 0.10) | 4.90 ms (p95 0.10) | 65.9 ms (p95 0.60) | 23.2 ms (p95 0.30) |

<!-- bench-browser-results:end -->
