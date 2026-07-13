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

_Last run: 2026-07-13 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Versions: ours 0.11.0, incremark 1.0.2, streamdown 2.5.0, marked 16.4.2, smd 0.2.15, react-markdown 10.1.0._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | [react-markdown](https://github.com/remarkjs/react-markdown) | [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | [streamdown](https://github.com/vercel/streamdown) | [incremark react](https://github.com/kingshuaishuai/incremark) |
| :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 358 ms | 4670 ms | 156 ms | 1618 ms | 164 ms | 15.6 ms | 508 ms | 1399 ms | 415 ms | 360 ms | 2133 ms |
| incremark/test-md.md | 18091 | 199 | 610 ms | 12505 ms | 276 ms | 4206 ms | 289 ms | 26.0 ms | 751 ms | 5043 ms | 901 ms | 1417 ms | 4324 ms |
| README.md | 9000 | 200 | 470 ms | 3873 ms | 225 ms | 1362 ms | 223 ms | 21.4 ms | 526 ms | 1280 ms | 578 ms | 643 ms | 1024 ms |
| CHANGELOG.md | 14984 | 200 | 618 ms | 9597 ms | 311 ms | 3462 ms | 287 ms | 24.4 ms | 765 ms | 3529 ms | 795 ms | 1058 ms | 2064 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 2298 ms | 25883 ms | 1167 ms | 9339 ms | 1229 ms | 50.8 ms | 2465 ms | 7398 ms | 3778 ms | 3718 ms | 5982 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 283 ms | 3414 ms | 139 ms | 1183 ms | 128 ms | 15.4 ms | 340 ms | 1015 ms | 327 ms | 334 ms | 751 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 413 ms | 1743 ms | 259 ms | 724 ms | 270 ms | 10.3 ms | 441 ms | 440 ms | 297 ms | 176 ms | 418 ms |
| synthetic/long-transcript | 118942 | 200 | 2838 ms | 111062 ms | 1513 ms | 27067 ms | 1396 ms | 95.9 ms | 3326 ms | 28716 ms | 4826 ms | 35484 ms | 21925 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 49.1 ms | 1342 ms | 32.7 ms | 836 ms | 265 ms | 14.2 ms | 112 ms | 474 ms | 301 ms | 208 ms | 423 ms |

### Per-update latency on the long transcript (DOM tier)

| library | mean/update | p50 | p95 | max |
| :-- | --: | --: | --: | --: |
| [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | 14.2 ms | 8.00 ms | 20.1 ms | 513 ms |
| [ours string→innerHTML](https://github.com/copse-dev/streaming-markdown) | 555 ms | 545 ms | 1062 ms | 1799 ms |
| [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | 7.56 ms | 4.79 ms | 12.8 ms | 181 ms |
| [ours unsafe→innerHTML](https://github.com/copse-dev/streaming-markdown) | 135 ms | 139 ms | 239 ms | 301 ms |
| [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | 6.98 ms | 4.07 ms | 12.4 ms | 182 ms |
| [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) | 0.48 ms | 0.36 ms | 0.74 ms | 6.95 ms |
| [ours react (StreamingMarkdown)](https://github.com/copse-dev/streaming-markdown) | 16.6 ms | 9.87 ms | 22.2 ms | 497 ms |
| [react-markdown](https://github.com/remarkjs/react-markdown) | 144 ms | 155 ms | 240 ms | 291 ms |
| [react-markdown + memo blocks](https://github.com/remarkjs/react-markdown) | 24.1 ms | 22.6 ms | 52.3 ms | 72.2 ms |
| [streamdown](https://github.com/vercel/streamdown) | 177 ms | 155 ms | 375 ms | 410 ms |
| [incremark react](https://github.com/kingshuaishuai/incremark) | 109 ms | 96.9 ms | 265 ms | 395 ms |

### Pipeline only: per-chunk parse/render work, no DOM (Incremark’s published methodology)

| fixture | chars | updates | [ours renderMarkdownUnsafe](https://github.com/copse-dev/streaming-markdown) | [ours renderStreamingMarkdown](https://github.com/copse-dev/streaming-markdown) | [incremark core.append](https://github.com/kingshuaishuai/incremark) | [streamdown parseMarkdownIntoBlocks](https://github.com/vercel/streamdown) | [marked full re-parse](https://github.com/markedjs/marked) |
| :-- | --: | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 299 ms | 3646 ms | 13.9 ms | 47.2 ms | 50.8 ms |
| incremark/test-md.md | 18091 | 199 | 858 ms | 10933 ms | 32.1 ms | 281 ms | 240 ms |
| README.md | 9000 | 200 | 403 ms | 2574 ms | 48.8 ms | 9.59 ms | 96.7 ms |
| CHANGELOG.md | 14984 | 200 | 948 ms | 6636 ms | 33.9 ms | 246 ms | 214 ms |
| docs/ARCHITECTURE.md | 49982 | 200 | 2283 ms | 17121 ms | 1288 ms | 109 ms | 751 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 319 ms | 2370 ms | 16.0 ms | 62.7 ms | 74.3 ms |
| synthetic/code-heavy (#155) | 12285 | 199 | 31.8 ms | 1168 ms | 15.1 ms | 9.07 ms | 15.7 ms |
| synthetic/long-transcript | 118942 | 200 | 7877 ms | 94223 ms | 962 ms | 114 ms | 1617 ms |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 39.5 ms | 828 ms | 15.8 ms | 14.3 ms | 18.0 ms |

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

_Last run: 2026-07-13 — node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5 (parity mode, uncapped), median of 3 runs. Fixture filter: `terms-of-service-streaming|README`. Contestant filter: `DOM incremental|smd \(`. Versions: ours 0.11.0, smd 0.2.15._

### End-to-end: streamed chunks → live DOM (jsdom)

| fixture | chars | updates | [ours DOM incremental](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (unsafe)](https://github.com/copse-dev/streaming-markdown) | [ours DOM incremental (smd parity)](https://github.com/copse-dev/streaming-markdown) | [smd (streaming-markdown)](https://github.com/thetarnav/streaming-markdown) |
| :-- | --: | --: | --: | --: | --: | --: |
| README.md | 9000 | 1800 | 1709 ms | 799 ms | 804 ms | 17.1 ms |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 1044 | 834 ms | 301 ms | 280 ms | 18.5 ms |

<!-- bench-results-parity:end -->

### Real-browser tier: Chromium, layout included

Generated by `npm run bench:competitors:browser -- --update-docs`
([`bench-browser-live.mts`](../bench/competitors/bench-browser-live.mts)) —
same corpus and chunking as the jsdom tables above, per-update timing includes
a forced style recalc + layout. Direct-DOM contestants only (see the jsdom
caveat above for why); cells are total ms with per-update p95 in parentheses.

<!-- bench-browser-results:begin (generated by bench-browser-live — do not edit by hand) -->

_Real-browser tier: Chromium via playwright-core, layout forced per update (`offsetHeight`), 2026-07-13, node v22.22.2, Intel(R) Xeon(R) Processor @ 2.80GHz, chunk=5, capped at 200 updates/fixture, median of 3 runs. Our sanitized row used: DOMPurify backend._

| fixture | chars | updates | ours DOM incremental | ours DOM incremental (unsafe) | ours DOM incremental (smd parity) | smd (streaming-markdown) |
| :-- | --: | --: | --: | --: | --: | --: |
| incremark/P1.5_COLOR_SYSTEM_REPORT.md | 9338 | 199 | 146 ms (p95 1.60) | 80.9 ms (p95 0.90) | 68.4 ms (p95 0.80) | 34.7 ms (p95 0.30) |
| incremark/test-md.md | 18091 | 199 | 219 ms (p95 2.50) | 139 ms (p95 1.50) | 138 ms (p95 1.40) | 59.8 ms (p95 0.50) |
| README.md | 9000 | 200 | 170 ms (p95 1.70) | 97.8 ms (p95 1.00) | 107 ms (p95 1.20) | 21.5 ms (p95 0.20) |
| CHANGELOG.md | 14984 | 200 | 204 ms (p95 1.60) | 127 ms (p95 1.00) | 122 ms (p95 1.00) | 34.3 ms (p95 0.30) |
| docs/ARCHITECTURE.md | 49982 | 200 | 548 ms (p95 5.70) | 391 ms (p95 3.90) | 398 ms (p95 3.90) | 59.8 ms (p95 0.50) |
| tests/fixtures/terms-of-service-streaming.md | 5220 | 194 | 92.4 ms (p95 1.00) | 64.3 ms (p95 0.70) | 55.0 ms (p95 0.60) | 14.7 ms (p95 0.20) |
| synthetic/code-heavy (#155) | 12285 | 199 | 113 ms (p95 0.90) | 83.6 ms (p95 0.70) | 84.0 ms (p95 0.70) | 34.6 ms (p95 0.40) |
| synthetic/long-transcript | 118942 | 200 | 698 ms (p95 5.40) | 563 ms (p95 4.30) | 523 ms (p95 3.70) | 173 ms (p95 1.30) |
| synthetic/raw-html-details (#0004) | 12343 | 200 | 10.1 ms (p95 0.10) | 7.30 ms (p95 0.10) | 88.2 ms (p95 0.80) | 30.3 ms (p95 0.30) |

<!-- bench-browser-results:end -->
