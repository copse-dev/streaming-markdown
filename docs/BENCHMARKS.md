# Cross-library streaming benchmarks

Published, reproducible numbers comparing this library with the other
streaming-markdown renderers people actually evaluate against
([Streamdown](https://streamdown.ai),
[react-markdown](https://github.com/remarkjs/react-markdown) with and without
the recommended block memoization,
[smd / `streaming-markdown`](https://github.com/thetarnav/streaming-markdown),
and [Incremark](https://github.com/kingshuaishuai/incremark)). Filed as #157;
the harness lives in [`bench/competitors/`](../bench/competitors/).

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
  our highlighter/math/mermaid/emoji are likewise not loaded here. The
  remaining gap to smd is architectural: smd appends tokens and never
  revisits committed output, while our renderer re-tokenizes the stream and
  morphs the pending tail (what buys mid-stream GFM correctness).
- **Highlighting:** no highlighter is registered for our renderer,
  react-markdown and smd render code as plain text, so those compare
  markdown work. Streamdown's and Incremark-react's built-in highlighting is
  part of their defaults and left enabled — their code-heavy numbers include
  it.
- **jsdom is not a browser.** Layout, paint, style recalc and CLS do not
  exist in jsdom; the DOM tier measures JS + DOM-tree work only. Real-browser
  frame times / layout-shift measurement is a planned follow-up (the harness
  is structured so a Playwright runner can reuse the same corpus and
  contestants).
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

_Last run: 2026-07-11 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.10.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | ours DOM incremental | ours string→innerHTML | ours DOM incremental (unsafe) | ours unsafe→innerHTML | smd (streaming-markdown) | react-markdown | react-markdown + memo blocks | streamdown | incremark react |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 390 ms | 3235 ms | 198 ms | 1069 ms | 14.6 ms | 963 ms | 294 ms | 231 ms | 1445 ms |
| incremark/test-md.md | 18091 | 199 | 592 ms | 9543 ms | 287 ms | 3037 ms | 28.9 ms | 3372 ms | 726 ms | 978 ms | 2975 ms |
| README.md | 8521 | 199 | 385 ms | 2422 ms | 218 ms | 1020 ms | 12.0 ms | 868 ms | 399 ms | 354 ms | 771 ms |
| CHANGELOG.md | 12270 | 198 | 452 ms | 5863 ms | 238 ms | 1991 ms | 18.5 ms | 1908 ms | 524 ms | 625 ms | 1234 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 1562 ms | 18234 ms | 1046 ms | 6066 ms | 39.3 ms | 4550 ms | 2280 ms | 2426 ms | 3661 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 348 ms | 2218 ms | 190 ms | 846 ms | 7.83 ms | 707 ms | 242 ms | 244 ms | 565 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 324 ms | 1376 ms | 228 ms | 572 ms | 7.49 ms | 351 ms | 234 ms | 132 ms | 317 ms |
| synthetic/long-transcript | 113865 | 200 | 2878 ms | 77912 ms | 1803 ms | 19112 ms | 73.8 ms | 19518 ms | 3427 ms | 9810 ms | 15204 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| ours DOM incremental | 14.4 ms | 9.49 ms | 18.6 ms | 416 ms |
| ours string→innerHTML | 390 ms | 420 ms | 670 ms | 1652 ms |
| ours DOM incremental (unsafe) | 9.01 ms | 7.14 ms | 12.9 ms | 206 ms |
| ours unsafe→innerHTML | 95.6 ms | 98.5 ms | 166 ms | 211 ms |
| smd (streaming-markdown) | 0.37 ms | 0.28 ms | 0.62 ms | 5.55 ms |
| react-markdown | 97.6 ms | 102 ms | 171 ms | 223 ms |
| react-markdown + memo blocks | 17.1 ms | 16.1 ms | 35.6 ms | 79.8 ms |
| streamdown | 49.1 ms | 43.1 ms | 97.3 ms | 139 ms |
| incremark react | 75.6 ms | 69.5 ms | 151 ms | 232 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | ours renderMarkdownUnsafe | ours renderStreamingMarkdown | incremark core.append | streamdown parseMarkdownIntoBlocks | marked full re-parse |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 188 ms | 2607 ms | 17.8 ms | 36.3 ms | 38.9 ms |
| incremark/test-md.md | 18091 | 199 | 697 ms | 7113 ms | 23.2 ms | 198 ms | 178 ms |
| README.md | 8521 | 199 | 272 ms | 1671 ms | 29.9 ms | 6.51 ms | 65.3 ms |
| CHANGELOG.md | 12270 | 198 | 514 ms | 3830 ms | 21.3 ms | 148 ms | 143 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 1531 ms | 11580 ms | 841 ms | 58.7 ms | 543 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 234 ms | 1610 ms | 12.6 ms | 50.3 ms | 46.3 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 22.7 ms | 784 ms | 11.3 ms | 6.81 ms | 11.2 ms |
| synthetic/long-transcript | 113865 | 200 | 5103 ms | 64586 ms | 734 ms | 86.4 ms | 1168 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| ours (DOM + string core) | 88.5 kB | 29.7 kB | 88.5 kB | 29.7 kB | optional peers external (native Sanitizer path) |
| smd (streaming-markdown) | 14.7 kB | 4.3 kB | 14.7 kB | 4.3 kB | dependency-free |
| react-markdown | 114.8 kB | 35.5 kB | 114.8 kB | 35.5 kB | React runtime external (peer) |
| streamdown | 488.3 kB | 145.4 kB | 488.3 kB | 145.4 kB | React runtime external (peer); lazy chunks = mermaid etc. |
| incremark (@incremark/core) | 72.3 kB | 21.1 kB | 72.3 kB | 21.1 kB | parser only — no renderer |
| incremark (@incremark/react) | 9545.0 kB | 1837.3 kB | 9545.0 kB | 1837.3 kB | React runtime + katex/mermaid peers external; shiki bundles |

<!-- bench-results:end -->
