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

_Last run: 2026-07-12 — node v22.23.1, AMD EPYC 7763 64-Core Processor, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.10.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | ours DOM incremental | ours string→innerHTML | ours DOM incremental (unsafe) | ours unsafe→innerHTML | smd (streaming-markdown) | ours react (StreamingMarkdown) | react-markdown | react-markdown + memo blocks | streamdown | incremark react |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 359 ms | 3147 ms | 211 ms | 1135 ms | 22.5 ms | 415 ms | 888 ms | 293 ms | 235 ms | 1473 ms |
| incremark/test-md.md | 18091 | 199 | 544 ms | 9101 ms | 304 ms | 3050 ms | 30.1 ms | 629 ms | 2974 ms | 665 ms | 933 ms | 2880 ms |
| README.md | 9000 | 200 | 401 ms | 2585 ms | 212 ms | 1007 ms | 15.3 ms | 449 ms | 902 ms | 421 ms | 444 ms | 740 ms |
| CHANGELOG.md | 12270 | 198 | 455 ms | 5666 ms | 236 ms | 2058 ms | 27.4 ms | 511 ms | 1727 ms | 529 ms | 583 ms | 1150 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1839 ms | 17525 ms | 1114 ms | 6229 ms | 58.9 ms | 1929 ms | 4271 ms | 2198 ms | 2218 ms | 3811 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 347 ms | 2263 ms | 202 ms | 786 ms | 12.2 ms | 395 ms | 609 ms | 254 ms | 229 ms | 522 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 324 ms | 1396 ms | 232 ms | 546 ms | 11.7 ms | 374 ms | 317 ms | 218 ms | 133 ms | 320 ms |
| synthetic/long-transcript | 116228 | 200 | 2925 ms | 77219 ms | 1863 ms | 19053 ms | 70.0 ms | 3217 ms | 18066 ms | 3234 ms | 21021 ms | 14015 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| ours DOM incremental | 14.6 ms | 10.2 ms | 19.3 ms | 408 ms |
| ours string→innerHTML | 386 ms | 392 ms | 694 ms | 1826 ms |
| ours DOM incremental (unsafe) | 9.31 ms | 7.30 ms | 13.4 ms | 197 ms |
| ours unsafe→innerHTML | 95.3 ms | 99.0 ms | 169 ms | 193 ms |
| smd (streaming-markdown) | 0.35 ms | 0.28 ms | 0.57 ms | 4.91 ms |
| ours react (StreamingMarkdown) | 16.1 ms | 11.6 ms | 21.2 ms | 415 ms |
| react-markdown | 90.3 ms | 95.2 ms | 160 ms | 258 ms |
| react-markdown + memo blocks | 16.2 ms | 15.1 ms | 33.8 ms | 37.6 ms |
| streamdown | 105 ms | 90.9 ms | 220 ms | 242 ms |
| incremark react | 69.7 ms | 64.8 ms | 143 ms | 218 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | ours renderMarkdownUnsafe | ours renderStreamingMarkdown | incremark core.append | streamdown parseMarkdownIntoBlocks | marked full re-parse |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 190 ms | 2140 ms | 17.4 ms | 37.6 ms | 42.4 ms |
| incremark/test-md.md | 18091 | 199 | 654 ms | 6052 ms | 25.3 ms | 198 ms | 180 ms |
| README.md | 9000 | 200 | 300 ms | 1767 ms | 36.1 ms | 9.73 ms | 76.2 ms |
| CHANGELOG.md | 12270 | 198 | 508 ms | 3841 ms | 28.6 ms | 155 ms | 135 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 1469 ms | 11759 ms | 865 ms | 63.8 ms | 534 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 249 ms | 1580 ms | 15.5 ms | 48.5 ms | 47.7 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 25.1 ms | 801 ms | 11.4 ms | 10.8 ms | 15.3 ms |
| synthetic/long-transcript | 116228 | 200 | 5080 ms | 59818 ms | 700 ms | 89.6 ms | 1190 ms |

### Bundle size (esbuild, minified, browser, es2022)

| library | initial (min) | initial (min+gz) | total incl. lazy (min) | total (min+gz) | notes |
| :-- | --: | --: | --: | --: | :-- |
| ours (DOM + string core) | 91.0 kB | 30.5 kB | 91.0 kB | 30.5 kB | optional peers external (native Sanitizer path) |
| smd (streaming-markdown) | 14.7 kB | 4.3 kB | 14.7 kB | 4.3 kB | dependency-free |
| react-markdown | 114.8 kB | 35.5 kB | 114.8 kB | 35.5 kB | React runtime external (peer) |
| streamdown | 488.3 kB | 145.4 kB | 488.3 kB | 145.4 kB | React runtime external (peer); lazy chunks = mermaid etc. |
| incremark (@incremark/core) | 72.3 kB | 21.1 kB | 72.3 kB | 21.1 kB | parser only — no renderer |
| incremark (@incremark/react) | 9545.0 kB | 1837.3 kB | 9545.0 kB | 1837.3 kB | React runtime + katex/mermaid peers external; shiki bundles |

<!-- bench-results:end -->
