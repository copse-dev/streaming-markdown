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
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 457 ms | 4281 ms | 21.0 ms | 1273 ms | 359 ms | 360 ms | 2044 ms |
| incremark/test-md.md | 18091 | 199 | 730 ms | 11866 ms | 29.2 ms | 4409 ms | 847 ms | 1331 ms | 3973 ms |
| README.md | 8521 | 199 | 466 ms | 3429 ms | 14.9 ms | 1157 ms | 513 ms | 469 ms | 999 ms |
| CHANGELOG.md | 12270 | 198 | 585 ms | 7501 ms | 19.5 ms | 2559 ms | 660 ms | 812 ms | 1639 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 1941 ms | 22409 ms | 47.5 ms | 6184 ms | 3137 ms | 3479 ms | 5090 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 475 ms | 3069 ms | 10.3 ms | 1092 ms | 321 ms | 315 ms | 686 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 406 ms | 1770 ms | 8.90 ms | 434 ms | 304 ms | 181 ms | 430 ms |
| synthetic/long-transcript | 113865 | 200 | 3617 ms | skipped | 97.0 ms | 24236 ms | 4328 ms | 15733 ms | 19907 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| ours DOM incremental | 18.1 ms | 13.0 ms | 22.2 ms | 517 ms |
| smd (streaming-markdown) | 0.48 ms | 0.37 ms | 0.82 ms | 7.52 ms |
| react-markdown | 121 ms | 126 ms | 210 ms | 345 ms |
| react-markdown + memo blocks | 21.6 ms | 19.4 ms | 44.5 ms | 60.9 ms |
| streamdown | 78.7 ms | 67.5 ms | 163 ms | 197 ms |
| incremark react | 99.0 ms | 90.0 ms | 230 ms | 359 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | ours renderMarkdownUnsafe | ours renderStreamingMarkdown | incremark core.append | streamdown parseMarkdownIntoBlocks | marked full re-parse |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 240 ms | 2812 ms | 19.7 ms | 45.1 ms | 50.2 ms |
| incremark/test-md.md | 18091 | 199 | 1011 ms | 8051 ms | 30.5 ms | 251 ms | 219 ms |
| README.md | 8521 | 199 | 365 ms | 2114 ms | 40.1 ms | 10.1 ms | 85.4 ms |
| CHANGELOG.md | 12270 | 198 | 676 ms | 5121 ms | 23.9 ms | 196 ms | 170 ms |
| docs/ARCHITECTURE.md | 48098 | 200 | 1998 ms | 14268 ms | 1060 ms | 77.4 ms | 650 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 314 ms | 2180 ms | 15.6 ms | 59.0 ms | 58.9 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 29.2 ms | 1061 ms | 15.5 ms | 8.94 ms | 15.3 ms |
| synthetic/long-transcript | 113865 | 200 | 6983 ms | skipped | 901 ms | 118 ms | 1447 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| ours (DOM + string core) | 88.5 kB | 29.7 kB | 88.5 kB | 29.7 kB | optional peers external (native Sanitizer path) |
| smd (streaming-markdown) | 14.7 kB | 4.3 kB | 14.7 kB | 4.3 kB | dependency-free |
| react-markdown | 114.8 kB | 35.5 kB | 114.8 kB | 35.5 kB | React runtime external (peer) |
| streamdown | 488.3 kB | 145.4 kB | 488.3 kB | 145.4 kB | React runtime external (peer); lazy chunks = mermaid etc. |
| incremark (@incremark/core) | 72.3 kB | 21.1 kB | 72.3 kB | 21.1 kB | parser only — no renderer |
| incremark (@incremark/react) | 9545.0 kB | 1837.3 kB | 9545.0 kB | 1837.3 kB | React runtime + katex/mermaid peers external; shiki bundles |

Skipped in this run:
- ours renderStreamingMarkdown on synthetic/long-transcript: child process exited 134 (crash/OOM)
- ours string→innerHTML on synthetic/long-transcript: child process exited 134 (crash/OOM)

<!-- bench-results:end -->
