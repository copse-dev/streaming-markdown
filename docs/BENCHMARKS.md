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
- **Output validation.** A speed number is meaningless if the library got
  there by rendering less, so after each DOM-tier contestant streams a fixture
  we read its rendered DOM back and measure *what* it produced — the same way
  for every library: visible-text length, the fraction of the source's word
  tokens that reached that visible text (**coverage**), and counts of the
  structural elements the markdown implies (headings, code blocks, tables,
  list items, links, emphasis). Word tokens are alphanumeric runs of ≥ 4
  characters, tokenized identically over the source and over each library's
  rendered text. Columns that track together are the evidence that the timing
  table compares equivalent work — that a library posting a 30× win is doing
  so architecturally, not by silently dropping content. (This is where smd's
  numbers hold up: on the long transcript it renders the same headings, code
  blocks, tables and list items as ours, at near-identical coverage — its lead
  is the append-only architecture, not skipped output.) The read is taken after
  the DOM **settles**: async renderers (Streamdown highlights and re-parses in
  effects that commit after `flushSync` returns) are polled across macrotasks
  until their output stops growing, so their coverage reflects the true final
  document — not the near-empty synchronous snapshot. This settle applies to the
  validation read only; the timing table still measures the synchronous window
  (see the async-rendering caveat below). `raw-html-details` is exempt from the
  coverage read: ours deliberately *holds* the pending tail inside the
  still-open `<details>` (#138), so lower coverage there is correct behaviour,
  not a defect — see the corpus note.
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
- **Streamdown renders asynchronously — its DOM-tier *time* is not
  comparable.** The output-validation pass surfaced this: after a synchronous
  `flushSync` chunk, Streamdown's DOM is near-empty (it highlights and
  re-parses in effects that commit a few ticks later); its full output only
  appears once the microtask/macrotask queue drains. The validation read waits
  for that settle, so Streamdown's **coverage** is truthful — but the **timing
  table does not**: it measures only the synchronous window, so Streamdown's
  DOM-tier milliseconds *understate* its real per-update cost (the async render
  lands off the timed critical path). Read Streamdown's DOM-tier time as a
  lower bound, not an end-to-end figure; its coverage/structure columns are the
  trustworthy part. One structure-column wrinkle, also surfaced by the
  validation: Streamdown wraps inline emphasis and links in styled
  `<span data-streamdown="…">` rather than semantic `<a>`/`<strong>`/`<em>`, so
  its **links** and **emphasis** counts read near-zero even though that text is
  present (its coverage is ~99%) — a semantics/accessibility difference, not
  dropped content.
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

_Last run: 2026-07-13 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.11.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | [react-markdown](https://github.com/remarkjs/react-markdown) | [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | [streamdown](https://github.com/vercel/streamdown) | [incremark react](https://github.com/kingshuaishuai/incremark) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 306 ms | 3880 ms | 136 ms | 1253 ms | 127 ms | 16.2 ms | 380 ms | 1191 ms | 407 ms | 319 ms | 1797 ms |
| incremark/test-md.md | 18091 | 199 | 546 ms | 10510 ms | 245 ms | 3576 ms | 242 ms | 23.6 ms | 661 ms | 4447 ms | 847 ms | 1136 ms | 3704 ms |
| README.md | 9000 | 200 | 392 ms | 3092 ms | 196 ms | 1276 ms | 204 ms | 14.8 ms | 486 ms | 1105 ms | 508 ms | 519 ms | 860 ms |
| CHANGELOG.md | 14984 | 200 | 508 ms | 8043 ms | 242 ms | 2878 ms | 256 ms | 21.3 ms | 636 ms | 2826 ms | 794 ms | 851 ms | 1925 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1838 ms | 22752 ms | 1052 ms | 7622 ms | 1137 ms | 51.8 ms | 2114 ms | 5715 ms | 2852 ms | 2446 ms | 4881 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 253 ms | 2766 ms | 109 ms | 947 ms | 106 ms | 9.91 ms | 320 ms | 886 ms | 269 ms | 265 ms | 587 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 320 ms | 1654 ms | 207 ms | 609 ms | 206 ms | 10.1 ms | 401 ms | 356 ms | 249 ms | 138 ms | 314 ms |
| synthetic/long-transcript | 118942 | 200 | 2479 ms | 103463 ms | 1188 ms | 22909 ms | 1232 ms | 76.5 ms | 2911 ms | 23900 ms | 4345 ms | 22969 ms | 18695 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 49.0 ms | 1152 ms | 29.6 ms | 670 ms | 199 ms | 8.71 ms | 108 ms | 420 ms | 263 ms | 150 ms | 326 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 12.4 ms | 7.12 ms | 19.6 ms | 411 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 517 ms | 525 ms | 943 ms | 1978 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 5.94 ms | 3.34 ms | 10.6 ms | 165 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 115 ms | 121 ms | 203 ms | 342 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 6.16 ms | 3.49 ms | 10.6 ms | 181 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.38 ms | 0.29 ms | 0.63 ms | 5.65 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 14.6 ms | 8.91 ms | 20.9 ms | 453 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 120 ms | 124 ms | 205 ms | 321 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 21.7 ms | 21.0 ms | 45.8 ms | 54.5 ms |
| [streamdown](https://github.com/vercel/streamdown) | 115 ms | 99.9 ms | 241 ms | 263 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 93.0 ms | 88.3 ms | 189 ms | 270 ms |

### Output validation — did every library render the same corpus?

After each contestant streams a fixture, its rendered DOM is read back and measured — so the timing table above can be trusted to compare equivalent work, not reward a library for silently dropping content. Same metric for every library. Word-token coverage of the visible text, per fixture (columns that track together mean everyone rendered the same document):

| fixture | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | [react-markdown](https://github.com/remarkjs/react-markdown) | [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | [streamdown](https://github.com/vercel/streamdown) | [incremark react](https://github.com/kingshuaishuai/incremark) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 98.9% | 98.9% | 98.9% | 98.9% | 98.9% | 97.9% | 98.9% | 98.9% | 98.9% | 96.8% | 98.9% |
| incremark/test-md.md | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 98.5% | 98.5% |
| README.md | 99.0% | 99.0% | 99.0% | 99.0% | 99.0% | 92.1% | 99.0% | 99.0% | 98.5% | 99.0% | 98.0% |
| CHANGELOG.md | 99.7% | 99.7% | 99.7% | 99.7% | 99.7% | 96.1% | 99.7% | 99.7% | 99.7% | 99.7% | 97.1% |
| docs/ARCHITECTURE.md | 99.8% | 99.8% | 99.8% | 99.8% | 99.8% | 94.8% | 99.8% | 99.9% | 99.9% | 99.8% | 99.6% |
| tests/fixtures/terms-of-service-streaming.md | 93.3% | 93.3% | 93.3% | 93.3% | 93.3% | 96.1% | 93.3% | 99.6% | 98.0% | 90.9% | 89.0% |
| synthetic/code-heavy (#155) | 97.2% | 97.2% | 97.2% | 97.2% | 97.2% | 96.2% | 97.2% | 97.2% | 96.2% | 96.2% | 97.2% |
| synthetic/long-transcript | 99.1% | 99.1% | 99.1% | 99.1% | 99.1% | 96.2% | 99.1% | 99.7% | 99.5% | 99.0% | 98.1% |
| synthetic/raw-html-details (#0004) | 96.4% | 96.4% | 96.4% | 96.4% | 97.3% | 96.4% | 96.4% | 97.3% | 96.4% | 96.4% | 97.3% |

Rendered structure on the long transcript — element counts should track across libraries (the `raw-html-details` fixture is exempt: ours deliberately holds the tail inside the open `<details>`, so its coverage there is expected to differ — see the corpus note):

| library | visible text | coverage | headings | code | tables | list items | links | emphasis |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 103966 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 103966 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 103966 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 103966 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 103977 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 103202 chars | 96.2% | 259 | 74 | 11 | 489 | 70 | 280 |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 103966 chars | 99.1% | 260 | 73 | 11 | 490 | 58 | 279 |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 106006 chars | 99.7% | 260 | 73 | 0 | 490 | 47 | 279 |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 105748 chars | 99.5% | 260 | 73 | 0 | 490 | 47 | 279 |
| [streamdown](https://github.com/vercel/streamdown) | 104787 chars | 99.0% | 260 | 73 | 11 | 490 | 0 | 10 |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 104026 chars | 98.1% | 260 | 73 | 11 | 490 | 58 | 279 |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 214 ms | 2614 ms | 12.9 ms | 38.5 ms | 42.1 ms |
| incremark/test-md.md | 18091 | 199 | 731 ms | 7456 ms | 24.7 ms | 210 ms | 195 ms |
| README.md | 9000 | 200 | 350 ms | 2115 ms | 40.1 ms | 7.33 ms | 76.0 ms |
| CHANGELOG.md | 14984 | 200 | 727 ms | 5515 ms | 22.2 ms | 208 ms | 179 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1850 ms | 14739 ms | 1031 ms | 69.0 ms | 607 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 247 ms | 1987 ms | 13.9 ms | 50.1 ms | 53.0 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 24.6 ms | 927 ms | 13.9 ms | 7.03 ms | 11.2 ms |
| synthetic/long-transcript | 118942 | 200 | 6285 ms | 76395 ms | 806 ms | 93.9 ms | 1456 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 30.1 ms | 731 ms | 12.3 ms | 11.6 ms | 14.3 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| [ours (DOM + string core)](https://github.com/copse-dev/streaming-markdown) | 100.9 kB | 33.3 kB | 100.9 kB | 33.3 kB | optional peers external (native Sanitizer path) |
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
