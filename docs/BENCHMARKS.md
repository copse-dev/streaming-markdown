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

_Last run: 2026-07-12 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.10GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.11.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | [react-markdown](https://github.com/remarkjs/react-markdown) | [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | [streamdown](https://github.com/vercel/streamdown) | [incremark react](https://github.com/kingshuaishuai/incremark) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 415 ms | 3034 ms | 194 ms | 1053 ms | 235 ms | 17.0 ms | 555 ms | 877 ms | 305 ms | 301 ms | 1260 ms |
| incremark/test-md.md | 18091 | 199 | 657 ms | 7783 ms | 307 ms | 2904 ms | 292 ms | 22.2 ms | 689 ms | 2811 ms | 674 ms | 1066 ms | 2687 ms |
| README.md | 9000 | 200 | 506 ms | 2629 ms | 248 ms | 1043 ms | 227 ms | 14.4 ms | 537 ms | 865 ms | 455 ms | 558 ms | 819 ms |
| CHANGELOG.md | 14984 | 200 | 578 ms | 6144 ms | 281 ms | 2397 ms | 280 ms | 17.2 ms | 659 ms | 1928 ms | 607 ms | 822 ms | 1302 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1845 ms | 15195 ms | 1138 ms | 6088 ms | 1087 ms | 47.0 ms | 1860 ms | 3897 ms | 2039 ms | 2608 ms | 3372 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 382 ms | 2143 ms | 188 ms | 813 ms | 202 ms | 12.6 ms | 464 ms | 628 ms | 266 ms | 255 ms | 515 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 323 ms | 1330 ms | 206 ms | 539 ms | 232 ms | 7.73 ms | 412 ms | 302 ms | 237 ms | 127 ms | 319 ms |
| synthetic/long-transcript | 118942 | 200 | 2763 ms | 62083 ms | 1755 ms | 18351 ms | 1795 ms | 77.0 ms | 3229 ms | 16534 ms | 2971 ms | 24580 ms | 12888 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 13.8 ms | 9.85 ms | 18.6 ms | 361 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 310 ms | 318 ms | 554 ms | 1468 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 8.78 ms | 7.11 ms | 12.1 ms | 182 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 91.8 ms | 90.2 ms | 164 ms | 213 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 8.98 ms | 7.30 ms | 12.5 ms | 189 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.38 ms | 0.30 ms | 0.67 ms | 4.62 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 16.1 ms | 11.7 ms | 20.2 ms | 445 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 82.7 ms | 88.9 ms | 153 ms | 197 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 14.9 ms | 15.1 ms | 28.1 ms | 46.8 ms |
| [streamdown](https://github.com/vercel/streamdown) | 123 ms | 106 ms | 262 ms | 271 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 64.1 ms | 59.7 ms | 113 ms | 373 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 182 ms | 2135 ms | 10.6 ms | 48.6 ms | 34.9 ms |
| incremark/test-md.md | 18091 | 199 | 647 ms | 5614 ms | 22.9 ms | 206 ms | 205 ms |
| README.md | 9000 | 200 | 275 ms | 1682 ms | 31.7 ms | 8.01 ms | 68.5 ms |
| CHANGELOG.md | 14984 | 200 | 669 ms | 4358 ms | 19.7 ms | 176 ms | 151 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1464 ms | 10071 ms | 856 ms | 62.8 ms | 506 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 256 ms | 1489 ms | 14.0 ms | 49.3 ms | 39.8 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 21.2 ms | 822 ms | 11.4 ms | 7.63 ms | 10.8 ms |
| synthetic/long-transcript | 118942 | 200 | 5454 ms | 49184 ms | 676 ms | 80.6 ms | 1121 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| [ours (DOM + string core)](https://github.com/copse-dev/streaming-markdown) | 90.9 kB | 30.3 kB | 90.9 kB | 30.3 kB | optional peers external (native Sanitizer path) |
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

_Real-browser tier: Chromium via playwright-core, layout forced per update (`offsetHeight`), 2026-07-12, node v22.22.2, Intel(R) Xeon(R) Processor @ 2.10GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Our sanitized row used: DOMPurify backend._

| fixture | chars | updates | ours DOM incremental | ours DOM incremental (unsafe) | ours DOM incremental (smd parity) | smd (streaming-markdown) |
| :-- | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 113 ms (p95 1.30) | 56.9 ms (p95 0.80) | 52.7 ms (p95 0.70) | 19.3 ms (p95 0.20) |
| incremark/test-md.md | 18091 | 199 | 190 ms (p95 1.80) | 116 ms (p95 1.20) | 122 ms (p95 1.20) | 37.5 ms (p95 0.40) |
| README.md | 9000 | 200 | 142 ms (p95 1.50) | 82.0 ms (p95 0.90) | 76.8 ms (p95 0.90) | 12.1 ms (p95 0.20) |
| CHANGELOG.md | 14984 | 200 | 172 ms (p95 1.40) | 96.2 ms (p95 0.80) | 91.9 ms (p95 0.80) | 20.0 ms (p95 0.20) |
| docs/ARCHITECTURE.md | 49982 | 200 | 423 ms (p95 3.90) | 300 ms (p95 2.80) | 285 ms (p95 2.80) | 42.0 ms (p95 0.40) |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 74.1 ms (p95 0.90) | 38.9 ms (p95 0.50) | 38.9 ms (p95 0.50) | 9.90 ms (p95 0.10) |
| synthetic/code-heavy (#155) | 12285 | 199 | 73.8 ms (p95 0.60) | 58.5 ms (p95 0.60) | 55.5 ms (p95 0.50) | 23.7 ms (p95 0.30) |
| synthetic/long-transcript | 118942 | 200 | 589 ms (p95 4.90) | 438 ms (p95 3.00) | 423 ms (p95 3.00) | 118 ms (p95 1.00) |

<!-- bench-browser-results:end -->
