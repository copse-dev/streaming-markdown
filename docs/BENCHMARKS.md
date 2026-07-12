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
  (`htmlPolicy: 'escape'`, tag literalized, nothing held) is the only cell
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
  (`emailAutolinks: false`); and raw HTML passthrough
  (`htmlPolicy: 'escape'`, matching smd's render-tags-as-text behaviour).
  What stays enabled matches [smd's own README
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
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 305 ms | 3336 ms | 125 ms | 1076 ms | 139 ms | 15.2 ms | 368 ms | 966 ms | 309 ms | 266 ms | 1537 ms |
| incremark/test-md.md | 18091 | 199 | 495 ms | 8951 ms | 218 ms | 2929 ms | 242 ms | 23.4 ms | 603 ms | 3396 ms | 692 ms | 950 ms | 2970 ms |
| README.md | 9000 | 200 | 369 ms | 2936 ms | 200 ms | 1076 ms | 184 ms | 13.5 ms | 469 ms | 906 ms | 451 ms | 476 ms | 797 ms |
| CHANGELOG.md | 14984 | 200 | 496 ms | 7061 ms | 259 ms | 2509 ms | 224 ms | 20.6 ms | 571 ms | 2257 ms | 612 ms | 738 ms | 1489 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1568 ms | 19020 ms | 811 ms | 6951 ms | 821 ms | 48.2 ms | 1774 ms | 5397 ms | 2481 ms | 2318 ms | 4142 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 306 ms | 2382 ms | 133 ms | 882 ms | 130 ms | 12.0 ms | 354 ms | 698 ms | 245 ms | 243 ms | 605 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 311 ms | 1358 ms | 213 ms | 568 ms | 197 ms | 9.58 ms | 400 ms | 328 ms | 249 ms | 130 ms | 325 ms |
| synthetic/long-transcript | 118942 | 200 | 2277 ms | 90925 ms | 1178 ms | 20799 ms | 1151 ms | 71.0 ms | 2532 ms | 20166 ms | 3658 ms | 21836 ms | 16878 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 43.9 ms | 1028 ms | 30.1 ms | 600 ms | 196 ms | 8.62 ms | 95.0 ms | 377 ms | 249 ms | 160 ms | 316 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 11.4 ms | 6.34 ms | 14.7 ms | 435 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 455 ms | 438 ms | 824 ms | 1637 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 5.89 ms | 3.40 ms | 8.57 ms | 215 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 104 ms | 108 ms | 186 ms | 218 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 5.75 ms | 3.24 ms | 8.74 ms | 226 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.35 ms | 0.28 ms | 0.62 ms | 4.18 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 12.7 ms | 7.26 ms | 17.4 ms | 428 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 101 ms | 106 ms | 180 ms | 247 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 18.3 ms | 16.6 ms | 36.6 ms | 57.6 ms |
| [streamdown](https://github.com/vercel/streamdown) | 109 ms | 95.2 ms | 230 ms | 252 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 84.0 ms | 77.5 ms | 180 ms | 352 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 212 ms | 2250 ms | 12.9 ms | 34.0 ms | 42.4 ms |
| incremark/test-md.md | 18091 | 199 | 722 ms | 6657 ms | 24.8 ms | 210 ms | 185 ms |
| README.md | 9000 | 200 | 303 ms | 1791 ms | 33.2 ms | 6.71 ms | 72.2 ms |
| CHANGELOG.md | 14984 | 200 | 635 ms | 4783 ms | 24.9 ms | 194 ms | 169 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1718 ms | 12036 ms | 954 ms | 64.5 ms | 553 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 248 ms | 1676 ms | 12.9 ms | 48.4 ms | 48.9 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 25.8 ms | 847 ms | 12.8 ms | 6.99 ms | 11.0 ms |
| synthetic/long-transcript | 118942 | 200 | 5645 ms | 67160 ms | 717 ms | 90.9 ms | 1307 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 27.8 ms | 607 ms | 11.7 ms | 12.0 ms | 12.8 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| [ours (DOM + string core)](https://github.com/copse-dev/streaming-markdown) | 94.1 kB | 31.3 kB | 94.1 kB | 31.3 kB | optional peers external (native Sanitizer path) |
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
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 110 ms (p95 1.20) | 57.4 ms (p95 0.70) | 56.6 ms (p95 0.70) | 28.0 ms (p95 0.30) |
| incremark/test-md.md | 18091 | 199 | 182 ms (p95 2.10) | 118 ms (p95 1.30) | 110 ms (p95 1.20) | 38.9 ms (p95 0.40) |
| README.md | 9000 | 200 | 131 ms (p95 1.40) | 78.2 ms (p95 0.80) | 78.8 ms (p95 0.80) | 15.7 ms (p95 0.20) |
| CHANGELOG.md | 14984 | 200 | 167 ms (p95 1.30) | 97.3 ms (p95 0.70) | 95.5 ms (p95 0.80) | 33.6 ms (p95 0.30) |
| docs/ARCHITECTURE.md | 49982 | 200 | 458 ms (p95 4.30) | 307 ms (p95 3.10) | 297 ms (p95 3.10) | 40.9 ms (p95 0.40) |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 82.5 ms (p95 0.80) | 45.1 ms (p95 0.50) | 44.7 ms (p95 0.40) | 11.7 ms (p95 0.20) |
| synthetic/code-heavy (#155) | 12285 | 199 | 93.7 ms (p95 0.80) | 69.3 ms (p95 0.60) | 66.0 ms (p95 0.60) | 29.8 ms (p95 0.40) |
| synthetic/long-transcript | 118942 | 200 | 586 ms (p95 4.50) | 423 ms (p95 2.90) | 427 ms (p95 3.20) | 130 ms (p95 1.00) |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 9.20 ms (p95 0.10) | 5.50 ms (p95 0.10) | 75.6 ms (p95 0.70) | 25.0 ms (p95 0.30) |

<!-- bench-browser-results:end -->
