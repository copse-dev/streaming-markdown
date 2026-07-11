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

| fixture | chars | updates | ours DOM incremental | ours string→innerHTML | smd (streaming-markdown) | react-markdown | react-markdown + memo blocks | streamdown | incremark react |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 453 ms | 4155 ms | 17.7 ms | 1296 ms | 348 ms | 353 ms | 2178 ms |
| incremark/test-md.md | 18091 | 199 | 681 ms | 11874 ms | 28.0 ms | 4647 ms | 848 ms | 1332 ms | 4029 ms |
| README.md | 8521 | 199 | 466 ms | 3173 ms | 15.8 ms | 1142 ms | 503 ms | 462 ms | 990 ms |
| CHANGELOG.md | 12270 | 198 | 573 ms | 7163 ms | 23.9 ms | 2543 ms | 602 ms | 795 ms | 1641 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 1890 ms | 22423 ms | 50.7 ms | 6448 ms | 3094 ms | 3483 ms | 5084 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 415 ms | 2950 ms | 10.3 ms | 879 ms | 336 ms | 302 ms | 603 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 417 ms | 1767 ms | 9.61 ms | 414 ms | 284 ms | 171 ms | 351 ms |
| synthetic/long-transcript | 113865 | 200 | 3933 ms | 99558 ms | 86.4 ms | 24216 ms | 4299 ms | 15899 ms | 19978 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| ours DOM incremental | 19.7 ms | 14.1 ms | 25.9 ms | 507 ms |
| ours string→innerHTML | 498 ms | 507 ms | 913 ms | 2223 ms |
| smd (streaming-markdown) | 0.43 ms | 0.35 ms | 0.70 ms | 5.45 ms |
| react-markdown | 121 ms | 137 ms | 216 ms | 259 ms |
| react-markdown + memo blocks | 21.5 ms | 20.1 ms | 48.2 ms | 94.0 ms |
| streamdown | 79.5 ms | 67.9 ms | 166 ms | 205 ms |
| incremark react | 99.4 ms | 92.2 ms | 220 ms | 296 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | ours renderMarkdownUnsafe | ours renderStreamingMarkdown | incremark core.append | streamdown parseMarkdownIntoBlocks | marked full re-parse |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 247 ms | 2818 ms | 14.4 ms | 49.8 ms | 48.6 ms |
| incremark/test-md.md | 18091 | 199 | 895 ms | 7947 ms | 31.1 ms | 244 ms | 225 ms |
| README.md | 8521 | 199 | 369 ms | 2195 ms | 41.8 ms | 8.17 ms | 92.5 ms |
| CHANGELOG.md | 12270 | 198 | 657 ms | 4747 ms | 25.0 ms | 194 ms | 168 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 2026 ms | 14124 ms | 1081 ms | 76.4 ms | 665 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 337 ms | 2051 ms | 15.9 ms | 60.0 ms | 58.7 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 28.6 ms | 1054 ms | 14.4 ms | 11.1 ms | 14.6 ms |
| synthetic/long-transcript | 113865 | 200 | 6644 ms | 77318 ms | 905 ms | 119 ms | 1536 ms |

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
